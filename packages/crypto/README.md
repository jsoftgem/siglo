# @siglo/crypto

> Zero-dependency cryptographic step package for Siglo workflows: timing-safe webhook verification, AEAD envelope field encryption, and context redaction.

---

## Features

- **Timing-Attack Safe**: Guarantees constant-time buffer comparison via `node:crypto.timingSafeEqual` with strict length guards.
- **Replay Attack Defense**: Automatic header timestamp parsing and configurable tolerance windows (`toleranceSeconds: 300`).
- **Zero Serialization Skew**: Enforces verification strictly over raw `Buffer` or unparsed payload strings before JSON parsing.
- **Pluggable Webhook Strategies**: Built-in presets for Stripe, GitHub, Shopify, Slack, Svix / Standard Webhooks, and generic HMAC, plus support for custom protocols and asymmetric Ed25519/RSA keys.
- **Envelope Encryption**: Field-level AES-256-GCM encryption with fresh 96-bit (12-byte) IVs per invocation for securing sensitive context across durable checkpoints.
- **Context Redaction & Masking**: Declarative PII masking (`maskFieldsStep`) with presets for SSNs, credit cards, emails, and custom patterns.
- **Zero External Dependencies**: Built entirely on Node.js standard libraries (`node:crypto`).

---

## Installation

```bash
npm install @siglo/crypto
```

---

## Usage Examples

### 1. Webhook Signature Verification

```typescript
import { flow } from '@siglo/core';
import { verifyWebhookStep } from '@siglo/crypto';

interface WebhookContext {
  rawBody: string;
  headers: Record<string, string>;
}

export const processWebhook = flow(
  verifyWebhookStep('verifyStripe', {
    provider: 'stripe',
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
    payload: (ctx: WebhookContext) => ctx.rawBody,
    signature: (ctx: WebhookContext) => ctx.headers['stripe-signature'],
    toleranceSeconds: 300,
  })
);
```

### 2. Envelope Field Encryption across Durable Checkpoints

```typescript
import { flow, waitForEvent, Step } from '@siglo/core';
import { encryptFieldsStep, decryptFieldsStep } from '@siglo/crypto';

interface UserContext {
  userId: string;
  ssn: string;
  creditCard: string;
}

export const sensitiveWorkflow = flow(
  // Encrypt sensitive fields before saving durable checkpoint
  encryptFieldsStep('securePii', {
    fields: ['ssn', 'creditCard'],
    secretKey: process.env.MASTER_KEY!,
  }),

  // State in checkpoint storage (PostgreSQL/Redis) is encrypted at rest!
  waitForEvent('USER_VERIFIED', {
    correlationKey: (ctx: UserContext) => ctx.userId,
    timeout: '24h'
  }),

  // Decrypt fields back into plaintext upon workflow resumption
  decryptFieldsStep('unprotectPii', {
    fields: ['ssn', 'creditCard'],
    secretKey: process.env.MASTER_KEY!,
  })
);
```

### 3. Context Redaction / Masking

```typescript
import { flow } from '@siglo/core';
import { maskFieldsStep, maskPatterns } from '@siglo/crypto';

export const sanitizeWorkflow = flow(
  maskFieldsStep('maskSensitiveData', {
    fields: ['creditCard', 'ssn'],
    maskPattern: maskPatterns.last4,
  })
);
```

### 4. Custom Asymmetric Webhook Protocol (Ed25519)

```typescript
import { verifyWebhookStep, WebhookProtocol } from '@siglo/crypto';
import crypto from 'node:crypto';

export const customEd25519Protocol: WebhookProtocol = {
  name: 'custom-ed25519',
  verify({ secret, rawPayload, headers, signatureHeader, toleranceSeconds = 300 }) {
    const timestamp = Number(headers['x-timestamp']);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      return false;
    }

    const toSign = Buffer.from(`${timestamp}.${rawPayload}`);
    const signature = Buffer.from(signatureHeader, 'base64');
    return crypto.verify(null, toSign, secret, signature);
  }
};
```

---

## License

MIT © Jerico de Guzman
