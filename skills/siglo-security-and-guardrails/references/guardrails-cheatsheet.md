# Siglo Security & Network Guardrails Cheatsheet

Quick reference for zero-trust network egress policies, ASL perimeter controls, and cryptographic protection in Siglo.

---

## 1. Network Policy Configuration

### `NetworkPolicyConfig` Interface

```typescript
interface NetworkPolicyConfig {
    /** Target host patterns permitted for outbound network calls */
    allowedHosts?: (string | RegExp)[];

    /** Default fallback behavior: 'deny' (default) or 'allow' */
    defaultPolicy?: 'allow' | 'deny';

    /** Permit loopback connections: 127.0.0.1, localhost, ::1 (default: false when policy active) */
    allowLocalhost?: boolean;

    /** Permitted Unix domain socket paths for local IPC */
    allowUnixSockets?: string[];
}
```

### Pattern Match Rules for `allowedHosts`

| Pattern            | Example                          | Matches                             | Does NOT Match                     |
| :----------------- | :------------------------------- | :---------------------------------- | :--------------------------------- |
| Exact FQDN         | `'api.stripe.com'`               | `https://api.stripe.com/v1`         | `sub.api.stripe.com`, `stripe.com` |
| Wildcard Domain    | `'*.stripe.com'`                 | `api.stripe.com`, `auth.stripe.com` | `stripe.com`, `other.com`          |
| Host with Port     | `'internal.db:5432'`             | Port 5432 on `internal.db`          | Port 80 on `internal.db`           |
| Regular Expression | `/^api\.(us\|eu)\.vendor\.com$/` | `api.us.vendor.com`                 | `api.asia.vendor.com`              |

---

## 2. Step and Flow Guardrail Methods

| Method                                              | Target        | Description                                                                   |
| :-------------------------------------------------- | :------------ | :---------------------------------------------------------------------------- |
| `step.allowNetwork(hosts)`                          | `Step`        | Declares permitted hosts/subdomains for this step.                            |
| `step.denyNetwork()`                                | `Step`        | Shorthand for `.allowNetwork([])`. Blocks all outbound traffic.               |
| `step.allowUnixSockets(paths)`                      | `Step`        | Permits local Unix domain socket IPC paths.                                   |
| `step.networkPolicy(policy)`                        | `Step`        | Applies granular `NetworkPolicyConfig` to the step.                           |
| `flow.networkPolicy(policy)`                        | `Flow`        | Establishes the outer security perimeter across all steps.                    |
| `Step.compute(name, fn)` / `COMPUTE_NETWORK_POLICY` | `ComputeStep` | Unconditional `defaultPolicy: 'deny'` (`throwSync: true`); cannot be widened. |

---

## 3. `NetworkPolicyViolationException`

Thrown immediately when unauthorized egress is intercepted before socket connection:

```typescript
class NetworkPolicyViolationException extends SigloError {
    readonly host: string; // Target host intercepted
    readonly port: number; // Target port intercepted
    readonly phase: 'before' | 'action' | 'after' | 'validation'; // Active lifecycle phase
    readonly retryable = false; // Always non-retryable
    readonly metadata: {
        stepName: string;
        stackId: string;
        namespace?: string;
    };
}
```

---

## 4. `@siglo/crypto` Utilities

| Step Utility                       | Signature / Options                                               | Description                                                     |
| :--------------------------------- | :---------------------------------------------------------------- | :-------------------------------------------------------------- |
| `encryptFieldsStep(name, options)` | `{ fields: string[], key: string \| Buffer }`                     | AEAD AES-256-GCM authenticated field encryption.                |
| `decryptFieldsStep(name, options)` | `{ fields: string[], key: string \| Buffer }`                     | Decrypts previously encrypted fields in context.                |
| `verifyWebhookStep(name, options)` | `{ provider: string, secret: string, toleranceSeconds?: number }` | Timing-safe HMAC signature verification with replay protection. |
