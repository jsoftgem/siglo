# Security & Architecture Challenge: `@siglo/crypto` (Grill-Me)

> Rigorous technical questions, threat model interrogations, cryptographic boundary analyses, and edge-case operational challenges for the `@siglo/crypto` implementation and Siglo runtime integration.

---

## Executive Context

`@siglo/crypto` implements zero-dependency security primitives for `Siglo` workflows using native `node:crypto`. It covers:
1. **Timing-Safe Webhook Verification** (`verifyWebhookStep`)
2. **Replay Attack Defense** (`toleranceSeconds`)
3. **Pluggable Webhook Strategy Architecture** (`WebhookProtocol`)
4. **Envelope Encryption for Checkpoints** (`encryptFieldsStep`, `decryptFieldsStep`, AES-256-GCM)
5. **Context Redaction & PII Masking** (`maskFieldsStep`)

While all unit and integration tests pass with 100% specification compliance, mission-critical enterprise workflows operating under PCI-DSS, GDPR, HIPAA, and high-throughput multi-tenant environments encounter failure modes at the boundaries.

The following **5 Architectural & Security Challenge Rounds** evaluate the current design against production realities.

---

## Round 1: The Replay Tolerance Window Blind Spot

### Vulnerability Context
In [`verifyWebhookStep`](packages/crypto/src/webhooks/verify-step.ts), timestamp replay defense enforces:
```typescript
const toleranceSeconds = options.toleranceSeconds ?? 300;
if (toleranceSeconds > 0 && Math.abs(nowSec - tsSec) > toleranceSeconds) {
  throw new ValidationException(...);
}
```

### The Challenge
If an attacker intercepts a valid Stripe payment webhook at $t = 0$:
1. What stops them from re-transmitting that exact same valid request 500 times between $t = 1\text{s}$ and $t = 299\text{s}$?
2. Every re-transmitted request will have a cryptographically valid HMAC signature and a timestamp strictly within the 5-minute tolerance window.

### Key Questions to Address
- Does `@siglo/crypto` defend against intra-window replay duplication natively, or does it push the responsibility entirely to Siglo's `IdempotencyStore`?
- If defense relies on `IdempotencyStore`, how do you prevent an engineer from deploying `verifyWebhookStep` in a stateless or non-idempotent workflow where duplicate payments or charges get processed?
- What would an integrated, bounded, low-overhead nonce/signature deduplication cache look like inside `@siglo/crypto` (e.g. bloom filter, sliding TTL Redis set, or in-memory LRU ring buffer)?

---

## Round 2: AES-GCM Birthday Bound & IV Space Collisions

### Cryptographic Context
In [`encryptAESGCM`](packages/crypto/src/cipher/aes-gcm.ts), field encryption generates a random 96-bit (12-byte) Initialization Vector (IV) for every invocation:
```typescript
export function encryptAESGCM(data: unknown, key: string | Buffer): EncryptedEnvelope {
  const resolvedKey = resolveKey(key);
  const iv = crypto.randomBytes(12);
  ...
}
```

### The Challenge
Under **NIST SP 800-38D (Section 8.3)**, when using randomly generated 96-bit IVs with AES-GCM under the same static key, the probability of an IV collision reaches $2^{-32}$ after encrypting **$2^{32}$ (approx. 4.29 billion) records**.
- In AES-GCM, reusing the same $(Key, IV)$ pair across two distinct plaintexts is catastrophic: it exposes the Galois Hash authentication subkey $H$, allowing an attacker to forge valid authentication tags and decrypt traffic without the key.
- In high-throughput SaaS workflows running thousands of step executions per second, $2^{32}$ invocations can be reached within months.

### Key Questions to Address
- How should Siglo enforce maximum message thresholds per master key to guarantee NIST compliance?
- Why choose purely pseudo-random IVs (`crypto.randomBytes(12)`) instead of a deterministic construction (e.g. 64-bit random salt/node ID + 32-bit atomic monotonic counter, or per-workflow HKDF key derivation)?
- How should multi-tenant workflows isolate IV spaces across tenant boundaries when using a shared master key?

---

## Round 3: Key Rotation & Checkpoint Archeology

### Lifecycle Context
In [`encryptFieldsStep`](packages/crypto/src/cipher/encrypt-step.ts) and [`decryptFieldsStep`](packages/crypto/src/cipher/decrypt-step.ts), the steps operate using a single provided `secretKey`:
```typescript
export interface FieldCipherOptions<TInput> {
  fields: (keyof TInput)[];
  secretKey: string | Buffer | ((ctx: TInput) => string | Buffer);
}
```

### The Challenge
Consider a durable enterprise workflow that pauses on a long-running event:
```typescript
waitForEvent('LEGAL_APPROVAL', { timeout: '90d' })
```
1. **Day 1**: Workflow executes `encryptFieldsStep('protectSsn')` using `Key_2026_Q1`. The encrypted context is serialized into PostgreSQL checkpoint storage.
2. **Day 30**: SecOps executes quarterly key rotation. The environment variable `MASTER_KEY` is updated to `Key_2026_Q2`.
3. **Day 85**: The approval event arrives. The workflow resumes from the PostgreSQL checkpoint and executes `decryptFieldsStep('restoreSsn')`, which resolves `process.env.MASTER_KEY` (`Key_2026_Q2`).
4. **Result**: Authentication tag verification fails; `decryptFieldsStep` throws `ValidationException`, permanently failing the workflow.

### Key Questions to Address
- Notice that `EncryptedEnvelope` records only:
  ```typescript
  export interface EncryptedEnvelope {
    __sigloCipher: 'aes-256-gcm';
    iv: string;
    tag: string;
    data: string;
  }
  ```
  It lacks a `keyId`, `version`, or `algorithmId`. How can `decryptFieldsStep` support multi-key ring rotation (decrypting older checkpoints while encrypting new checkpoints with the active key)?
- How would `@siglo/crypto` integrate with cloud KMS providers (AWS KMS, GCP KMS, HashiCorp Vault) using Envelope Encryption patterns (Data Encryption Keys / DEKs wrapped by Key Encryption Keys / KEKs)?

---

## Round 4: Memory DoS vs. Raw Payload Buffer Enforcements

### Performance Context
[`verifyWebhookStep`](packages/crypto/src/webhooks/verify-step.ts) strictly asserts that the payload is a contiguous `Buffer` or raw `string` in memory:
```typescript
this.onBefore(async (ctx: TInput) => {
  const payload = options.payload(ctx);
  if (!isRawPayload(payload)) {
    throw new ValidationException(
      [{ field: 'payload', message: 'Payload must be a Buffer or raw unparsed string to prevent JSON serialization skew' }],
      { stepName: name, phase: 'before', retryable: false }
    );
  }
  return true;
});
```

### The Challenge
- High-volume systems receive large webhooks (e.g. 50MB–200MB multi-part data, bulk CDC batches, video transcode completion logs).
- If 500 concurrent webhook requests arrive simultaneously and each buffers 50MB into memory before invoking the workflow, Node.js will exceed heap limits and crash with an **Out-Of-Memory (OOM)** error.

### Key Questions to Address
- Can `verifyWebhookStep` support streaming HMAC calculation over `AsyncIterable<Buffer>` or Node.js `Readable` streams without buffering the entire payload in memory?
- If stream verification is possible, how do downstream workflow steps consume the payload without forcing an in-memory re-buffer or breaking checkpoint serialization?

---

## Round 5: Shallow Context Mutation & Deep PII Leakage

### Context Object Modeling
[`encryptFieldsStep`](packages/crypto/src/cipher/encrypt-step.ts) and [`maskFieldsStep`](packages/crypto/src/redaction/mask-step.ts) perform shallow object copies:
```typescript
const result = { ...ctx };
for (const field of options.fields) {
  const val = (ctx as any)[field];
  if (val !== undefined && val !== null && !isEncryptedEnvelope(val)) {
    (result as any)[field] = encryptAESGCM(val, resolvedKey);
  }
}
return result;
```

### The Challenge
1. **Nested PII Paths**: In real enterprise payloads, sensitive data is rarely at the root. It is commonly nested (e.g. `user.billing.taxId`, `passengers[0].passportNumber`). `keyof TInput` and shallow property access cannot address nested paths.
2. **Object Reference Sharing**: Because shallow copying (`{ ...ctx }`) is used, nested object references are shared. If a step downstream of `encryptFieldsStep` modifies `ctx.user`, it can inadvertently mutate un-cloned sub-objects, bypass encryption, or cause data race conditions in parallel combinator branches.

### Key Questions to Address
- Should `@siglo/crypto` support dot-notation path resolvers (e.g. `fields: ['user.taxId', 'orders.*.cardToken']`)?
- How should Siglo balance deep cloning performance against immutability and memory overhead when handling large context graphs?

---

## Summary Matrix

| Round | Focus Area | Attack / Failure Mode | Core Trade-off |
|---|---|---|---|
| **1** | Replay Protection | Intra-window replay storms ($t < 300\text{s}$) | In-memory/Redis nonce tracking overhead vs. Statelessness |
| **2** | AEAD Cryptography | AES-GCM IV collision after $2^{32}$ messages | Random IV simplicity vs. Counter/HKDF key lifecycle management |
| **3** | Key Management | Checkpoint resurrection failure across key rotation | Single-key simplicity vs. `keyId` envelope versioning |
| **4** | Performance & DoS | OOM crashes from contiguous buffer requirements | Streaming HMAC efficiency vs. Re-playable context storage |
| **5** | Context Integrity | Leaks from nested PII and shallow object spreading | Shallow spread speed vs. Deep path traversal & immutability |
