import { expect } from 'chai';
import crypto from 'node:crypto';
import { ValidationException } from '@siglo/core';
import {
  encryptAESGCM,
  decryptAESGCM,
  resolveKey,
  encryptFieldsStep,
  decryptFieldsStep,
  maskFieldsStep,
  maskPatterns,
  verifyWebhookStep,
  timingSafeCompare,
  GenericHmacWebhookProtocol,
  stripeProtocol,
  gitHubProtocol,
  shopifyProtocol,
  slackProtocol,
  svixProtocol
} from '../src';

describe('Crypto Package Edge Cases & Full Coverage', () => {
  describe('aes-gcm.ts error guards', () => {
    it('throws TypeError when secret key is not a string or Buffer', () => {
      expect(() => resolveKey(12345 as any)).to.throw(TypeError, 'Secret key must be a string or Buffer');
    });

    it('throws TypeError when decryptAESGCM receives invalid envelope', () => {
      expect(() => decryptAESGCM({} as any, 'key')).to.throw(TypeError, 'Invalid encrypted envelope structure');
    });

    it('returns raw string when decrypted payload is not valid JSON', () => {
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const rawText = 'plain-text-not-json{[';
      const data = Buffer.concat([cipher.update(rawText, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      const envelope = {
        __sigloCipher: 'aes-256-gcm' as const,
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: data.toString('hex')
      };

      const result = decryptAESGCM(envelope, key);
      expect(result).to.equal(rawText);
    });

    it('supports step.run() on encryptFieldsStep and decryptFieldsStep', async () => {
      const key = crypto.randomBytes(32);
      const enc = encryptFieldsStep('enc', { fields: ['secret'], secretKey: key });
      const dec = decryptFieldsStep('dec', { fields: ['secret'], secretKey: key });

      const encrypted = await enc.run({ secret: 'my-data' });
      const decrypted = await dec.run(encrypted);
      expect(decrypted.secret).to.equal('my-data');
    });

    it('throws ValidationException when decryptFieldsStep lacks secretKey', async () => {
      const dec = decryptFieldsStep('decNoKey', { fields: ['secret'], secretKey: '' as any });
      try {
        await dec.execute({ secret: { __sigloCipher: 'aes-256-gcm', iv: '', tag: '', data: '' } });
        expect.fail('Expected missing secretKey to throw');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].field).to.equal('secretKey');
      }
    });
  });

  describe('mask-step.ts presets and step.run()', () => {
    it('supports maskFieldsStep.run()', async () => {
      const step = maskFieldsStep('maskRun', { fields: ['code'], maskPattern: maskPatterns.redact });
      const res = await step.run({ code: 'abc' });
      expect(res.code).to.equal('[REDACTED]');
    });

    it('handles edge cases in maskPatterns presets', () => {
      expect(maskPatterns.email('a@b.com')).to.equal('*@b.com');
      expect(maskPatterns.email('')).to.equal('***');
      expect(maskPatterns.creditCard('')).to.equal('****-****-****-****');
      expect(maskPatterns.ssn('')).to.equal('***-**-****');
      expect(maskPatterns.last4('')).to.equal('****');
    });
  });

  describe('timingSafeCompare error guards', () => {
    it('returns false when encoding causes an error or invalid input', () => {
      const badObj: any = { toString: () => { throw new Error('boom'); } };
      expect(timingSafeCompare(badObj, 'test')).to.be.false;
    });
  });

  describe('Protocol Edge Cases', () => {
    it('Stripe protocol returns false on missing timestamp or missing v1 signature', () => {
      expect(stripeProtocol.verify({
        secret: 'sec',
        rawPayload: 'body',
        headers: {},
        signatureHeader: 't=123'
      })).to.be.false;

      expect(stripeProtocol.verify({
        secret: 'sec',
        rawPayload: 'body',
        headers: {},
        signatureHeader: 'v1=abc'
      })).to.be.false;
    });

    it('GitHub protocol parses signature without sha256= or sha1= prefix', () => {
      const parsed = gitHubProtocol.parseHeaders({}, 'plainhexsig123');
      expect(parsed.version).to.equal('sha256');
      expect(parsed.signatures).to.deep.equal(['plainhexsig123']);
    });

    it('Shopify protocol returns false on empty signature', () => {
      expect(shopifyProtocol.verify({
        secret: 'sec',
        rawPayload: 'body',
        headers: {},
        signatureHeader: ''
      })).to.be.false;
    });

    it('Slack protocol verifies signature without v0= prefix and rejects missing timestamp', () => {
      const secret = 'slack_sec';
      const now = Math.floor(Date.now() / 1000);
      const rawPayload = 'test-slack-payload';
      const toSign = `v0:${now}:${rawPayload}`;
      const sigHex = crypto.createHmac('sha256', secret).update(toSign).digest('hex');

      // Signature header passed as pure hex (no v0=)
      const valid = slackProtocol.verify({
        secret,
        rawPayload,
        headers: { 'x-slack-request-timestamp': String(now) },
        signatureHeader: sigHex
      });
      expect(valid).to.be.true;

      // Missing timestamp
      const invalid = slackProtocol.verify({
        secret,
        rawPayload,
        headers: {},
        signatureHeader: sigHex
      });
      expect(invalid).to.be.false;
    });

    it('Svix protocol verifies with whsec_ prefix and webhook-* standard headers', () => {
      const rawSecret = crypto.randomBytes(32);
      const whsecSecret = `whsec_${rawSecret.toString('base64')}`;
      const svixId = 'msg_standard_test';
      const now = Math.floor(Date.now() / 1000);
      const payload = '{"status":"ok"}';
      const toSign = `${svixId}.${now}.${payload}`;

      const sigBase64 = crypto.createHmac('sha256', rawSecret).update(toSign).digest('base64');
      const header = `v1=${sigBase64}`;

      const valid = svixProtocol.verify({
        secret: whsecSecret,
        rawPayload: payload,
        headers: {
          'webhook-id': svixId,
          'webhook-timestamp': String(now),
          'webhook-signature': header
        },
        signatureHeader: header
      });
      expect(valid).to.be.true;
    });

    it('Generic HMAC protocol supports explicit hex and base64 options', () => {
      const secret = 'custom_generic_sec';
      const payload = 'generic_data';
      const sigHex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const sigBase64 = crypto.createHmac('sha256', secret).update(payload).digest('base64');

      const hexProto = new GenericHmacWebhookProtocol({ encoding: 'hex' });
      expect(hexProto.verify({
        secret,
        rawPayload: payload,
        headers: {},
        signatureHeader: sigHex
      })).to.be.true;

      const b64Proto = new GenericHmacWebhookProtocol({ encoding: 'base64' });
      expect(b64Proto.verify({
        secret,
        rawPayload: payload,
        headers: {},
        signatureHeader: sigBase64
      })).to.be.true;
    });
  });

  describe('verifyWebhookStep step.run() & dynamic options', () => {
    it('supports step.run() on verifyWebhookStep', async () => {
      const secret = 'step_run_secret';
      const payload = 'body';
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      const step = verifyWebhookStep('verifyStepRun', {
        secret: () => secret,
        payload: (ctx: any) => ctx.body,
        signature: (ctx: any) => ctx.sig
      });

      const res = await step.run({ body: payload, sig });
      expect(res.webhookVerified).to.be.true;
      expect(res.provider).to.equal('generic-hmac');
    });

    it('resolves signature header from headers dictionary when signature option returns object', async () => {
      const secret = 'stripe_dict_sec';
      const payload = 'stripe_dict_body';
      const now = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', secret).update(`${now}.${payload}`).digest('hex');
      const header = `t=${now},v1=${sig}`;

      const step = verifyWebhookStep('verifyFromHeadersDict', {
        provider: 'stripe',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.headers
      });

      const res = await step.execute({
        rawBody: payload,
        headers: { 'stripe-signature': header }
      });
      expect(res.webhookVerified).to.be.true;
    });
  });
});
