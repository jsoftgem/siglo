import { expect } from 'chai';
import crypto from 'node:crypto';
import { ValidationException } from '@siglo/core';
import {
  verifyWebhookStep,
  registerWebhookProtocol,
  getWebhookProtocol,
  resetWebhookProtocols,
  WebhookProtocol
} from '../src';

describe('Custom & Pluggable Webhook Protocols', () => {
  afterEach(() => {
    resetWebhookProtocols();
  });

  it('supports inline custom WebhookProtocol instance', async () => {
    const customProtocol: WebhookProtocol = {
      name: 'inline-token-protocol',
      verify({ secret, rawPayload, headers, signatureHeader }) {
        return signatureHeader === `Bearer ${secret}` && rawPayload === 'ping';
      }
    };

    const step = verifyWebhookStep('verifyCustom', {
      provider: customProtocol,
      secret: 'super-token',
      payload: (ctx: any) => ctx.body,
      signature: (ctx: any) => ctx.authHeader
    });

    const result = await step.execute({
      body: 'ping',
      authHeader: 'Bearer super-token'
    });

    expect(result.webhookVerified).to.be.true;
    expect(result.provider).to.equal('inline-token-protocol');
  });

  it('supports globally registered protocol via registerWebhookProtocol', async () => {
    const myGatewayProtocol: WebhookProtocol = {
      name: 'internal-gateway',
      verify({ secret, rawPayload, signatureHeader }) {
        const expected = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');
        return signatureHeader === expected;
      }
    };

    registerWebhookProtocol('internal-gateway', myGatewayProtocol);
    expect(getWebhookProtocol('internal-gateway')).to.equal(myGatewayProtocol);

    const secret = 'gateway-secret-456';
    const body = 'message-content';
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

    const step = verifyWebhookStep('verifyGateway', {
      provider: 'internal-gateway',
      secret,
      payload: (ctx: any) => ctx.body,
      signature: (ctx: any) => ctx.signature
    });

    const result = await step.execute({ body, signature: sig });
    expect(result.webhookVerified).to.be.true;
    expect(result.provider).to.equal('internal-gateway');
  });

  it('dynamically resolves protocol strategy using context callback', async () => {
    const stripePayload = '{"event":"charge"}';
    const stripeSec = 'stripe_sec';
    const now = Math.floor(Date.now() / 1000);
    const stripeSig = `t=${now},v1=${crypto.createHmac('sha256', stripeSec).update(`${now}.${stripePayload}`).digest('hex')}`;

    const ghPayload = '{"action":"push"}';
    const ghSec = 'gh_sec';
    const ghSig = `sha256=${crypto.createHmac('sha256', ghSec).update(ghPayload).digest('hex')}`;

    const step = verifyWebhookStep('dynamicVerify', {
      provider: (ctx: any) => ctx.vendor,
      secret: (ctx: any) => ctx.vendor === 'stripe' ? stripeSec : ghSec,
      payload: (ctx: any) => ctx.rawBody,
      signature: (ctx: any) => ctx.headers['signature']
    });

    // Test vendor: stripe
    const resStripe = await step.execute({
      vendor: 'stripe',
      rawBody: stripePayload,
      headers: { signature: stripeSig }
    });
    expect(resStripe.provider).to.equal('stripe');

    // Test vendor: github
    const resGh = await step.execute({
      vendor: 'github',
      rawBody: ghPayload,
      headers: { signature: ghSig }
    });
    expect(resGh.provider).to.equal('github');
  });

  it('supports asymmetric Ed25519 public key verification', async () => {
    // Generate an Ed25519 keypair for asymmetric webhook testing
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const svixId = 'msg_p1b_ed25519';
    const now = Math.floor(Date.now() / 1000);
    const rawBody = '{"user":"alice","status":"active"}';
    const toSign = `${svixId}.${now}.${rawBody}`;

    const signature = crypto.sign(null, Buffer.from(toSign, 'utf8'), privateKey).toString('base64');
    const header = `v1,${signature}`;

    const step = verifyWebhookStep('verifySvixEd25519', {
      provider: 'svix',
      secret: publicKeyPem,
      payload: (ctx: any) => ctx.rawBody,
      signature: (ctx: any) => ctx.headers['svix-signature'],
      headers: (ctx: any) => ctx.headers
    });

    const result = await step.execute({
      rawBody,
      headers: {
        'svix-id': svixId,
        'svix-timestamp': String(now),
        'svix-signature': header
      }
    });

    expect(result.webhookVerified).to.be.true;
    expect(result.provider).to.equal('svix');
  });

  it('supports asymmetric RSA-SHA256 signature verification', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048
    });
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const rsaProtocol: WebhookProtocol = {
      name: 'rsa-sha256',
      verify({ secret, rawPayload, signatureHeader }) {
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(rawPayload);
        return verifier.verify(secret, signatureHeader, 'base64');
      }
    };

    const payload = 'raw-rsa-payload-stream';
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(payload);
    const signature = signer.sign(privateKey, 'base64');

    const step = verifyWebhookStep('verifyRsa', {
      provider: rsaProtocol,
      secret: publicKeyPem,
      payload: (ctx: any) => ctx.body,
      signature: (ctx: any) => ctx.sig
    });

    const result = await step.execute({
      body: payload,
      sig: signature
    });

    expect(result.webhookVerified).to.be.true;
  });
});
