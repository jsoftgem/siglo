import { expect } from 'chai';
import crypto from 'node:crypto';
import { flow, ValidationException } from '@siglo/core';
import { verifyWebhookStep } from '../src/webhooks/verify-step';

describe('Webhook Verification Step (verifyWebhookStep)', () => {
  describe('Stripe Preset Protocol', () => {
    const secret = 'whsec_test_stripe_secret_123';
    const payload = JSON.stringify({ id: 'evt_123', object: 'event' });

    it('successfully verifies a valid Stripe webhook with replay tolerance', async () => {
      const now = Math.floor(Date.now() / 1000);
      const toSign = `${now}.${payload}`;
      const sig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
      const stripeHeader = `t=${now},v1=${sig}`;

      const step = verifyWebhookStep('verifyStripe', {
        provider: 'stripe',
        secret,
        payload: (ctx: { rawBody: string; headers: Record<string, string> }) => ctx.rawBody,
        signature: (ctx: { rawBody: string; headers: Record<string, string> }) => ctx.headers['stripe-signature'],
        toleranceSeconds: 300
      });

      const result = await step.execute({
        rawBody: payload,
        headers: { 'stripe-signature': stripeHeader }
      });

      expect(result.webhookVerified).to.be.true;
      expect(result.provider).to.equal('stripe');
      expect(result.verifiedAt).to.equal(now);
    });

    it('verifies when multiple v1 signatures are present (key rotation)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const toSign = `${now}.${payload}`;
      const validSig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
      const dummySig = crypto.createHmac('sha256', 'old_key').update(toSign).digest('hex');
      const header = `t=${now},v1=${dummySig},v1=${validSig}`;

      const step = verifyWebhookStep('verifyStripe', {
        provider: 'stripe',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.headers['stripe-signature']
      });

      const result = await step.execute({
        rawBody: payload,
        headers: { 'stripe-signature': header }
      });

      expect(result.webhookVerified).to.be.true;
    });

    it('rejects tampered payload with ValidationException', async () => {
      const now = Math.floor(Date.now() / 1000);
      const toSign = `${now}.${payload}`;
      const sig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
      const header = `t=${now},v1=${sig}`;

      const step = verifyWebhookStep('verifyStripe', {
        provider: 'stripe',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.headers['stripe-signature']
      });

      try {
        await step.execute({
          rawBody: payload + 'tampered',
          headers: { 'stripe-signature': header }
        });
        expect.fail('Expected step to throw ValidationException');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].field).to.equal('signature');
        expect(err.phase).to.equal('action');
      }
    });
  });

  describe('GitHub Preset Protocol', () => {
    const secret = 'gh_webhook_secret_xyz';
    const payload = JSON.stringify({ action: 'opened', issue: { number: 42 } });

    it('verifies valid sha256 GitHub signature with raw string', async () => {
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const header = `sha256=${sig}`;

      const step = verifyWebhookStep('verifyGitHub', {
        provider: 'github',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.headers['x-hub-signature-256']
      });

      const result = await step.execute({
        rawBody: payload,
        headers: { 'x-hub-signature-256': header }
      });

      expect(result.webhookVerified).to.be.true;
      expect(result.provider).to.equal('github');
    });

    it('verifies valid GitHub signature with raw Buffer payload', async () => {
      const bufPayload = Buffer.from(payload, 'utf8');
      const sig = crypto.createHmac('sha256', secret).update(bufPayload).digest('hex');

      const step = verifyWebhookStep('verifyGitHub', {
        provider: 'github',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.headers['x-hub-signature-256']
      });

      const result = await step.execute({
        rawBody: bufPayload,
        headers: { 'x-hub-signature-256': `sha256=${sig}` }
      });

      expect(result.webhookVerified).to.be.true;
    });

    it('supports legacy sha1 signature', async () => {
      const sig = crypto.createHmac('sha1', secret).update(payload).digest('hex');

      const step = verifyWebhookStep('verifyGitHubSha1', {
        provider: 'github',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.headers['x-hub-signature']
      });

      const result = await step.execute({
        rawBody: payload,
        headers: { 'x-hub-signature': `sha1=${sig}` }
      });

      expect(result.webhookVerified).to.be.true;
    });
  });

  describe('Shopify Preset Protocol', () => {
    const secret = 'shopify_secret_key_789';
    const payload = JSON.stringify({ order_id: 1001, total: '99.00' });

    it('verifies valid base64 Shopify signature', async () => {
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64');

      const step = verifyWebhookStep('verifyShopify', {
        provider: 'shopify',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.headers['x-shopify-hmac-sha256']
      });

      const result = await step.execute({
        rawBody: payload,
        headers: { 'x-shopify-hmac-sha256': sig }
      });

      expect(result.webhookVerified).to.be.true;
      expect(result.provider).to.equal('shopify');
    });
  });

  describe('Slack Preset Protocol', () => {
    const secret = 'slack_signing_secret_abc';
    const payload = 'command=%2Fweather&text=Tokyo';

    it('verifies valid Slack v0 signature with request timestamp', async () => {
      const now = Math.floor(Date.now() / 1000);
      const toSign = `v0:${now}:${payload}`;
      const sigHex = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
      const header = `v0=${sigHex}`;

      const step = verifyWebhookStep('verifySlack', {
        provider: 'slack',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.headers['x-slack-signature'],
        headers: (ctx: any) => ctx.headers
      });

      const result = await step.execute({
        rawBody: payload,
        headers: {
          'x-slack-signature': header,
          'x-slack-request-timestamp': String(now)
        }
      });

      expect(result.webhookVerified).to.be.true;
      expect(result.provider).to.equal('slack');
    });
  });

  describe('Generic HMAC Preset Protocol', () => {
    const secret = 'generic_hmac_secret';
    const payload = 'custom-raw-message-stream';

    it('verifies sha256 generic hmac', async () => {
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      const step = verifyWebhookStep('verifyGeneric', {
        provider: 'generic-hmac',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.sig
      });

      const result = await step.execute({
        rawBody: payload,
        sig
      });

      expect(result.webhookVerified).to.be.true;
    });

    it('verifies sha512 generic hmac with base64 encoding', async () => {
      const sig = crypto.createHmac('sha512', secret).update(payload).digest('base64');

      const step = verifyWebhookStep('verifyGenericSha512', {
        provider: 'generic-hmac',
        algorithm: 'sha512',
        secret,
        payload: (ctx: any) => ctx.rawBody,
        signature: (ctx: any) => ctx.sig
      });

      const result = await step.execute({
        rawBody: payload,
        sig
      });

      expect(result.webhookVerified).to.be.true;
    });
  });

  describe('JSON Serialization Skew & Validation Guardrails', () => {
    it('throws ValidationException in BEFORE phase if payload is a parsed JSON object', async () => {
      const step = verifyWebhookStep('rejectObject', {
        provider: 'github',
        secret: 'sec',
        payload: (ctx: any) => ctx.body, // Object instead of string/Buffer
        signature: (ctx: any) => 'dummy-sig'
      });

      try {
        await step.execute({ body: { foo: 'bar' } });
        expect.fail('Expected step to fail on object payload');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].field).to.equal('payload');
        expect(err.phase).to.equal('before');
      }
    });

    it('throws ValidationException if secret is missing', async () => {
      const step = verifyWebhookStep('missingSecret', {
        provider: 'github',
        secret: '' as any,
        payload: (ctx: any) => 'raw',
        signature: (ctx: any) => 'dummy-sig'
      });

      try {
        await step.execute({});
        expect.fail('Expected missing secret to fail');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].field).to.equal('secret');
      }
    });

    it('throws ValidationException if signature header is missing', async () => {
      const step = verifyWebhookStep('missingSig', {
        provider: 'stripe',
        secret: 'stripe_sec',
        payload: (ctx: any) => 'raw',
        signature: (ctx: any) => ''
      });

      try {
        await step.execute({});
        expect.fail('Expected missing signature to fail');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].field).to.equal('signature');
      }
    });

    it('throws ValidationException in BEFORE phase if provider string is unknown', async () => {
      const step = verifyWebhookStep('unknownProvider', {
        provider: 'non-existent-provider',
        secret: 'sec',
        payload: (ctx: any) => 'raw',
        signature: (ctx: any) => 'sig'
      });

      try {
        await step.execute({});
        expect.fail('Expected unknown provider to fail');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].field).to.equal('provider');
      }
    });
  });

  describe('Siglo Flow Integration', () => {
    it('executes seamlessly inside a multi-step flow pipeline', async () => {
      const secret = 'whsec_flow_test';
      const rawBody = '{"event":"payment_intent.succeeded"}';
      const now = Math.floor(Date.now() / 1000);
      const sig = crypto.createHmac('sha256', secret).update(`${now}.${rawBody}`).digest('hex');

      const pipeline = flow(
        verifyWebhookStep('verifyStripe', {
          provider: 'stripe',
          secret,
          payload: (ctx: any) => ctx.rawBody,
          signature: (ctx: any) => ctx.headers['stripe-signature']
        })
      );

      const result = await pipeline.execute({
        rawBody,
        headers: { 'stripe-signature': `t=${now},v1=${sig}` }
      });

      expect(result.webhookVerified).to.be.true;
      expect(result.provider).to.equal('stripe');
      expect(result.rawBody).to.equal(rawBody);
    });
  });
});
