import { expect } from 'chai';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ValidationException } from '@siglo/core';
import {
  verifyWebhookStep,
  encryptFieldsStep,
  decryptFieldsStep,
  maskFieldsStep,
  encryptAESGCM,
  decryptAESGCM,
  deriveSubkey,
  StaticKeyRing,
  InMemoryNonceStore,
  createDedupKey,
  transformFields,
  deepFreeze,
  getKeyInvocationCount
} from '../src';
import { RedisNonceStore } from '../../redis/src/nonce';

describe('Enterprise Hardening & Resilience Suite (Grill-Me Remediation)', () => {
  describe('Round 1: Intra-Window Replay Defense & Nonce Deduplication', () => {
    it('rejects duplicate webhook delivery within the tolerance window using InMemoryNonceStore', async () => {
      const secret = 'whsec_replay_dedup_test';
      const payload = '{"event":"payment.succeeded"}';
      const dedupStore = new InMemoryNonceStore();

      const now = Math.floor(Date.now() / 1000);
      const toSign = `${now}.${payload}`;
      const sig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
      const header = `t=${now},v1=${sig}`;

      const step = verifyWebhookStep('testDedup', {
        provider: 'stripe',
        secret,
        payload: (ctx: any) => ctx.body,
        signature: (ctx: any) => ctx.header,
        dedupStore,
        toleranceSeconds: 300
      });

      // 1. First execution: succeeds and records claim
      const firstRes = await step.execute({ body: payload, header });
      expect(firstRes.webhookVerified).to.be.true;
      expect(firstRes.idempotencyKey).to.be.a('string');
      expect(dedupStore.size).to.equal(1);

      // 2. Intra-window replay: same timestamp, same signature, within 300s
      try {
        await step.execute({ body: payload, header });
        expect.fail('Expected duplicate intra-window replay to throw ValidationException');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].field).to.equal('signature');
        expect(err.errors[0].message).to.include('Replay detected: duplicate webhook signature');
        expect(err.retryable).to.be.false;
      }
    });

    it('works with RedisNonceStore using atomic SET NX EX mock', async () => {
      const redisMap = new Map<string, string>();
      const mockClient: any = {
        async set(key: string, val: string, _mode: string, _ttl: number, flag?: string) {
          if (flag === 'NX' && redisMap.has(key)) {
            return null;
          }
          redisMap.set(key, val);
          return 'OK';
        }
      };

      const redisStore = new RedisNonceStore({ client: mockClient, keyPrefix: 'test:dedup:' });
      const secret = 'whsec_redis_test';
      const payload = '{"msg":"test"}';
      const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

      const step = verifyWebhookStep('redisDedupStep', {
        provider: 'generic-hmac',
        secret,
        payload: (ctx: any) => ctx.body,
        signature: (ctx: any) => ctx.sig,
        dedupStore: redisStore,
        toleranceSeconds: 60
      });

      const res1 = await step.execute({ body: payload, sig });
      expect(res1.webhookVerified).to.be.true;

      // Duplicate request rejected by Redis claim
      try {
        await step.execute({ body: payload, sig });
        expect.fail('Expected Redis dedup rejection');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].message).to.include('Replay detected');
      }
    });
  });

  describe('Round 2: Cryptographic Hardening, AAD & HKDF Key Derivation', () => {
    const masterKey = 'master_secret_passphrase_for_testing_hkdf_32';

    it('derives context-bound subkeys via HKDF isolating keyspaces', () => {
      const keyWorkflowA = deriveSubkey(masterKey, 'workflow-instance-001');
      const keyWorkflowB = deriveSubkey(masterKey, 'workflow-instance-002');

      expect(keyWorkflowA.length).to.equal(32);
      expect(keyWorkflowB.length).to.equal(32);
      expect(keyWorkflowA.equals(keyWorkflowB)).to.be.false;

      const envelope = encryptAESGCM('secret-data', masterKey, { deriveKeyContext: 'workflow-instance-001' });
      const decrypted = decryptAESGCM(envelope, masterKey, { deriveKeyContext: 'workflow-instance-001' });
      expect(decrypted).to.equal('secret-data');

      // Decrypting under different workflow context fails auth tag verification
      expect(() => {
        decryptAESGCM(envelope, masterKey, { deriveKeyContext: 'workflow-instance-002' });
      }).to.throw();
    });

    it('binds tenant identity to AEAD authentication tag (AAD)', async () => {
      const tenantKey = crypto.randomBytes(32);

      // Encrypt with tenant-1 AAD
      const envelopeA = encryptAESGCM({ accountId: 101 }, tenantKey, { aad: 'tenant-1' });

      // Decrypting with matching AAD succeeds
      const decryptedA = decryptAESGCM(envelopeA, tenantKey, { aad: 'tenant-1' });
      expect(decryptedA).to.deep.equal({ accountId: 101 });

      // Cross-tenant swap attack: Attempting to decrypt with tenant-2 AAD fails
      expect(() => {
        decryptAESGCM(envelopeA, tenantKey, { aad: 'tenant-2' });
      }).to.throw();
    });

    it('tracks key invocation counts for static keys', () => {
      const key = crypto.randomBytes(32);
      const initialCount = getKeyInvocationCount(key);
      expect(initialCount).to.equal(0);

      encryptAESGCM('test1', key);
      encryptAESGCM('test2', key);

      expect(getKeyInvocationCount(key)).to.equal(2);
    });
  });

  describe('Round 3: Key Rotation & Checkpoint Archaeology', () => {
    const keyQ1 = crypto.randomBytes(32);
    const keyQ2 = crypto.randomBytes(32);

    it('decrypts historical checkpoints encrypted with older rotated keys using KeyRing', async () => {
      const keyRing = new StaticKeyRing('key-2026-q1', {
        'key-2026-q1': keyQ1
      });

      // 1. Day 1: Encrypt with Q1 active key
      const encryptStep = encryptFieldsStep('encryptSsn', {
        fields: ['user.ssn'],
        keyRing
      });

      const initialContext = {
        user: { name: 'Alice', ssn: '123-45-6789' },
        status: 'PENDING_APPROVAL'
      };

      const encryptedContext = await encryptStep.execute(initialContext);
      expect(encryptedContext.user.ssn.__sigloCipher).to.equal('aes-256-gcm');
      expect(encryptedContext.user.ssn.kid).to.equal('key-2026-q1');
      expect(encryptedContext.user.ssn.v).to.equal(1);

      // 2. Day 30: Rotate key ring to Q2 active key
      keyRing.addKey('key-2026-q2', keyQ2, true);
      expect(keyRing.getActiveKey().kid).to.equal('key-2026-q2');

      // 3. Day 85: Resumed workflow decrypts historical checkpoint
      let rekeyNotified = false;
      const decryptStep = decryptFieldsStep('decryptSsn', {
        fields: ['user.ssn'],
        keyRing,
        onNeedsRekey: (_ctx, field, oldKid, activeKid) => {
          rekeyNotified = true;
          expect(field).to.equal('user.ssn');
          expect(oldKid).to.equal('key-2026-q1');
          expect(activeKid).to.equal('key-2026-q2');
        }
      });

      const decryptedContext = await decryptStep.execute(encryptedContext);
      expect(decryptedContext.user.ssn).to.equal('123-45-6789');
      expect(rekeyNotified).to.be.true;

      // 4. Re-encrypt under active Q2 key
      const rekeyStep = encryptFieldsStep('rekeySsn', {
        fields: ['user.ssn'],
        keyRing
      });
      const rekeyedContext = await rekeyStep.execute(decryptedContext);
      expect(rekeyedContext.user.ssn.kid).to.equal('key-2026-q2');
    });

    it('throws ValidationException when envelope kid is not found in KeyRing', async () => {
      const keyRing = new StaticKeyRing('key-active', {
        'key-active': keyQ1
      });

      const envelope = encryptAESGCM('confidential', keyQ2, { kid: 'unknown-key-999' });

      const decryptStep = decryptFieldsStep('decryptUnknown', {
        fields: ['data'],
        keyRing
      });

      try {
        await decryptStep.execute({ data: envelope });
        expect.fail('Expected unknown kid to fail');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].message).to.include("key ID 'unknown-key-999' not found in KeyRing");
      }
    });
  });

  describe('Round 4: Streaming Payloads & Spooling Guardrails', () => {
    it('verifies streaming chunked payloads (AsyncIterable<Buffer>)', async () => {
      const secret = 'whsec_stream_test';
      const chunk1 = Buffer.from('{"batch":');
      const chunk2 = Buffer.from('[1,2,3]}');
      const fullPayload = Buffer.concat([chunk1, chunk2]);

      const sig = crypto.createHmac('sha256', secret).update(fullPayload).digest('hex');

      async function* createStream() {
        yield chunk1;
        yield chunk2;
      }

      const step = verifyWebhookStep('verifyStream', {
        provider: 'generic-hmac',
        secret,
        payload: (ctx: any) => ctx.stream,
        signature: (ctx: any) => ctx.sig
      });

      const res = await step.execute({ stream: createStream(), sig });
      expect(res.webhookVerified).to.be.true;
      expect(res.payloadRef?.storage).to.equal('memory');
      expect(res.payloadRef?.bytes).to.equal(fullPayload.length);
    });

    it('rejects payloads exceeding maxBodyBytes with non-retryable 413 ValidationException', async () => {
      const secret = 'whsec_oversized_test';
      const bigBuffer = Buffer.alloc(1024 * 1024 * 2, 'a'); // 2MB
      const sig = crypto.createHmac('sha256', secret).update(bigBuffer).digest('hex');

      const step = verifyWebhookStep('sizeGuardStep', {
        provider: 'generic-hmac',
        secret,
        payload: (ctx: any) => ctx.body,
        signature: (ctx: any) => ctx.sig,
        maxBodyBytes: 1024 * 1024 // 1MB limit
      });

      try {
        await step.execute({ body: bigBuffer, sig });
        expect.fail('Expected size guard to fail');
      } catch (err: any) {
        expect(err).to.be.instanceOf(ValidationException);
        expect(err.errors[0].field).to.equal('payload');
        expect(err.errors[0].message).to.include('Payload exceeds maximum allowed size');
        expect(err.retryable).to.be.false;
      }
    });

    it('spools large streaming payloads to ephemeral disk returning payloadRef pointer', async () => {
      const secret = 'whsec_spool_test';
      const chunk = Buffer.alloc(1024 * 100, 'x'); // 100KB chunks
      const sig = crypto.createHmac('sha256', secret).update(Buffer.concat([chunk, chunk])).digest('hex');

      async function* createStream() {
        yield chunk;
        yield chunk;
      }

      const step = verifyWebhookStep('spoolStep', {
        provider: 'generic-hmac',
        secret,
        payload: (ctx: any) => ctx.stream,
        signature: (ctx: any) => ctx.sig,
        spoolThresholdBytes: 50 * 1024 // 50KB threshold forces disk spooling
      });

      const res = await step.execute({ stream: createStream(), sig });
      expect(res.webhookVerified).to.be.true;
      expect(res.payloadRef?.storage).to.equal('file');
      expect(res.payloadRef?.path).to.be.a('string');
      expect(fs.existsSync(res.payloadRef!.path!)).to.be.true;

      // Clean up temp file
      fs.unlinkSync(res.payloadRef!.path!);
    });
  });

  describe('Round 5: Nested Dot-Notation Paths & Structural Sharing', () => {
    it('encrypts and decrypts deep dot-notation and wildcard paths with structural sharing', async () => {
      const key = crypto.randomBytes(32);

      const originalContext = {
        unrelated: { config: 'public' },
        user: {
          profile: { avatar: 'pic.png' },
          billing: { taxId: 'TAX-998877', card: { num: '4111111111111234' } }
        },
        orders: [
          { orderId: 1, token: 'tok_abc' },
          { orderId: 2, token: 'tok_xyz' }
        ]
      };

      // 1. Direct structural sharing validation on transformFields
      const directTransformed = transformFields(
        originalContext,
        ['user.billing.taxId'],
        (val) => encryptAESGCM(val, key)
      );
      // Untargeted branches MUST preserve exact referential equality
      expect(directTransformed.unrelated).to.equal(originalContext.unrelated);
      expect(directTransformed.user.profile).to.equal(originalContext.user.profile);
      expect(directTransformed.orders).to.equal(originalContext.orders);

      // 2. Step lifecycle execution
      const encryptStep = encryptFieldsStep('encryptDeep', {
        fields: ['user.billing.taxId', 'user.billing.card.num', 'orders.*.token'],
        secretKey: key
      });

      const encrypted = await encryptStep.execute(originalContext);

      // Verify targeted fields are encrypted envelopes
      expect(encrypted.user.billing.taxId.__sigloCipher).to.equal('aes-256-gcm');
      expect(encrypted.user.billing.card.num.__sigloCipher).to.equal('aes-256-gcm');
      expect(encrypted.orders[0].token.__sigloCipher).to.equal('aes-256-gcm');
      expect(encrypted.orders[1].token.__sigloCipher).to.equal('aes-256-gcm');
      expect(encrypted.unrelated).to.deep.equal(originalContext.unrelated);
      expect(encrypted.user.profile).to.deep.equal(originalContext.user.profile);

      // 3. Decrypt in-place
      const decryptStep = decryptFieldsStep('decryptDeep', {
        fields: ['user.billing.taxId', 'user.billing.card.num', 'orders.*.token'],
        secretKey: key
      });

      const decrypted = await decryptStep.execute(encrypted);
      expect(decrypted.user.billing.taxId).to.equal('TAX-998877');
      expect(decrypted.user.billing.card.num).to.equal('4111111111111234');
      expect(decrypted.orders[0].token).to.equal('tok_abc');
      expect(decrypted.orders[1].token).to.equal('tok_xyz');
      expect(decrypted.unrelated).to.deep.equal(originalContext.unrelated);
    });

    it('masks deep nested paths and array wildcards using maskFieldsStep', async () => {
      const ctx = {
        customers: [
          { name: 'John Doe', ssn: '123456789' },
          { name: 'Jane Smith', ssn: '987654321' }
        ]
      };

      const step = maskFieldsStep('maskSsnList', {
        fields: ['customers.*.ssn']
      });

      const res = await step.execute(ctx);
      expect(res.customers[0].ssn).to.equal('*****6789');
      expect(res.customers[1].ssn).to.equal('*****4321');
      expect(res.customers[0].name).to.equal('John Doe');
    });

    it('deepFreeze prevents recursive context mutation in test assertions', () => {
      const obj = { nested: { val: 42 } };
      deepFreeze(obj);
      expect(Object.isFrozen(obj)).to.be.true;
      expect(Object.isFrozen(obj.nested)).to.be.true;
    });
  });
});
