# @siglo/redis Adapter Guide

`@siglo/redis` provides an in-memory distributed persistence, step response caching, atomic idempotency deduplication, and distributed single-flight coordination layer for `Siglo` workflows. It is powered by Redis and compatible with standalone Redis, Redis Sentinel, and Redis Cluster via `ioredis`.

---

## 1. Overview & Architecture

The Redis adapter family encompasses three core modules:

```
                            @siglo/redis
       ┌────────────────────────────┼────────────────────────────┐
       │                            │                            │
       ▼                            ▼                            ▼
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ RedisStorageAdapter  │   │ RedisIdempotencyStore│   │      RedisLock       │
│ • Ephemeral State    │   │ • Atomic NX Claims   │   │ • Distributed Mutex  │
│ • Step Caching       │   │ • Result Caching     │   │ • Token Verification │
│ • Context Hash Stream│   │ • Fast Lock Release  │   │ • Safe Lua Releasing │
└──────────┬───────────┘   └──────────┬───────────┘   └──────────┬───────────┘
           │                          │                          │
           ▼                          ▼                          ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                             Redis Server                                   │
│                                                                            │
│  siglo:[<ns>:]checkpoint:<id>  siglo:idemp:<key>         siglo:lock:<key>  │
│  siglo:cache:<key>             siglo:[<ns>:]context:<id>:<step>            │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Installation & Requirements

Install `@siglo/redis` alongside `ioredis`:

```bash
npm install Siglo @siglo/redis ioredis
```

Peer dependency matrix:
- `Siglo`: `*` (v1.0.0+)
- `ioredis`: `^5.0.0 || ^6.0.0`

---

## 3. Key Topology & Redis Data Structures

`@siglo/redis` uses structured key namespaces:

| Key Pattern | Redis Type | Default TTL | Description |
| :--- | :--- | :--- | :--- |
| `siglo:[<ns>:]checkpoint:<stackId>` | `string` (JSON) | 7 days (`604800000ms`) | Serialized execution stack for workflow resumption. Partitioned by tenant namespace if provided (`siglo:<ns>:checkpoint:<stackId>`). |
| `siglo:cache:<key>` | `string` (JSON) | 24 hours (`86400000ms`) | Cached step evaluation output. |
| `siglo:[<ns>:]context:<stackId>:<stepId>` | `hash` | 7 days (`604800000ms`) | Active context field mutations for auditing. Partitioned by tenant namespace if provided (`siglo:<ns>:context:<stackId>:<stepId>`). |
| `siglo:idemp:<key>` | `string` | 24 hours (`86400000ms`) | Idempotency lock status (`in-progress` or `COMPLETED:<json>`). |
| `siglo:lock:<key>` | `string` (UUID) | Caller specified (e.g. 10s) | Distributed mutex lock holding worker token. |

---

## 4. `RedisStorageAdapter` Reference

Implements the standard `StorageAdapter` interface for high-performance checkpointing and step caching.

```typescript
import { RedisStorageAdapter } from '@siglo/redis';
```

### Options (`RedisStorageAdapterOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `client` | `RedisClientInterface \| Redis` | *Required* | Active `ioredis` instance. |
| `keyPrefix` | `string` | `'siglo:'` | Root prefix for all Redis keys. |
| `checkpointTtlMs` | `number` | `604800000` (7 days) | Checkpoint expiration TTL. |
| `cacheTtlMs` | `number` | `86400000` (24 hours) | Default step response cache expiration TTL. |
| `recordContextChanges` | `boolean` | `true` | When `true`, streams field updates to Redis Hashes. |

### Methods

- **`saveCheckpoint(checkpoint)`**: Saves JSON-serialized execution stack with millisecond TTL (`SET key val PX ttl`).
- **`getCheckpoint(stackId, namespace?)`**: Retrieves and parses serialized checkpoint (checks namespaced key first, falling back to legacy key). Returns `undefined` if not found.
- **`getCachedStep(key)`**: Retrieves cached step response.
- **`setCachedStep(key, value, ttlMs?)`**: Writes cached step response with specified TTL.
- **`onContextChange(entry)`**: Executes `HSET` on `siglo:[<ns>:]context:<stackId>:<stepId>` and refreshes TTL with `PEXPIRE`.

---

## 5. `RedisIdempotencyStore` Reference

Provides distributed, atomic idempotency guarantees across multi-instance clusters using Redis `SET key val PX ttl NX` semantics.

```typescript
import { RedisIdempotencyStore } from '@siglo/redis';
```

### Options (`RedisIdempotencyOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `client` | `RedisClientInterface \| Redis` | *Required* | Active `ioredis` instance. |
| `keyPrefix` | `string` | `'siglo:idemp:'` | Prefix for idempotency keys. |
| `defaultTtlMs` | `number` | `86400000` (24 hours) | Default lock TTL. |

### Claim States & Transitions:
1. **`claim(key, ttlMs?)`**:
   - Executes atomic Redis `SET <key> "in-progress" PX <ttl> NX`.
   - If Redis returns `'OK'`: Returns `'claimed'`.
   - If key exists and starts with `COMPLETED:`: Returns `'completed'`.
   - If key exists with value `in-progress`: Returns `'in-progress'`.
2. **`complete(key, result, ttlMs?)`**:
   - Overwrites key with `COMPLETED:${JSON.stringify(result)}`.
3. **`fail(key, error)`**:
   - Deletes the key if it is currently `'in-progress'`, freeing the lock so subsequent retries can proceed.
4. **`getResult(key)`**:
   - Returns the deserialized result for completed keys.

---

## 6. `RedisLock` (Distributed Mutex & Single-Flight Coordination)

`RedisLock` prevents duplicate parallel execution of sensitive workflows (e.g., end-of-month payroll, nightly data synchronization) across multiple server instances.

```typescript
import { RedisLock, RedisLockOptions } from '@siglo/redis';

// Simple prefix configuration:
const lock = new RedisLock(redis, 'siglo:lock:');

// Full options configuration:
const strictLock = new RedisLock(redis, {
    keyPrefix: 'siglo:lock:',
    strictAtomicity: true, // Enforces Redis eval (Lua) for atomic lock release
});
```

### Options (`RedisLockOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `keyPrefix` | `string` | `'siglo:lock:'` | Root prefix for distributed mutex keys. |
| `strictAtomicity` | `boolean` | `false` | When `true`, enforces strict atomic Lua evaluation (`client.eval`) during lock release, throwing an error if Lua scripting is unavailable rather than falling back to non-atomic commands, preventing TOCTOU race conditions. |

### Methods:

#### `acquire(lockKey, ttlMs?, customToken?)`
Attempts atomic acquisition (`SET key token PX ttl NX`). Returns `{ acquired: boolean, token: string }`.

#### `release(lockKey, token)`
Safely releases the lock only if the current value matches the caller's unique token. Uses atomic Lua scripting:
```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```
When `strictAtomicity` is enabled, failure or absence of Lua `eval` will throw an error to prevent non-atomic release races.

#### `withLock(lockKey, fn, ttlMs?)`
Executes an asynchronous function wrapped in single-flight protection:
- Acquires lock.
- If acquisition fails, throws `Error('Failed to acquire lock for key: ...')`.
- Executes `fn()`.
- Releases lock in a `finally` block, ensuring no leaked locks even on unhandled exceptions.

---

## 7. Complete Production Example

```typescript
import { Redis } from 'ioredis';
import { Step, flow } from 'siglo';
import {
    RedisStorageAdapter,
    RedisIdempotencyStore,
    RedisLock
} from '@siglo/redis';

// 1. Initialize Redis Client
const redis = new Redis('redis://localhost:6379');

// 2. Register Global Storage
const storageAdapter = new RedisStorageAdapter({
    client: redis,
    checkpointTtlMs: 86400000, // 24 hours
});
Step.useStorage(storageAdapter);

// 3. Initialize Idempotency & Distributed Lock
const idempotencyStore = new RedisIdempotencyStore({ client: redis });
const redisLock = new RedisLock(redis, { strictAtomicity: true });

// 4. Define Workflow with Step Caching
const fetchExchangeRates = Step.create('fetchRates', async () => {
    // Heavy external HTTP call
    return { EUR: 1.08, GBP: 1.27, JPY: 154.2 };
})
    .cache({ ttlMs: 300000, key: () => 'currency-rates-latest' }) // 5-minute cache
    ;

const settleInvoice = Step.create('settleInvoice', async ({ invoiceId, amount, currency }: any) => {
    return { invoiceId, settled: true, amountUSD: amount * 1.08 };
});

const billingFlow = flow(fetchExchangeRates, settleInvoice);

// 5. Single-Flight Execution Runner
async function processDailySettlement() {
    // Only one cluster node can execute this block at a time
    return await redisLock.withLock('lock:daily-settlement', async () => {
        console.log('Acquired single-flight lock. Starting settlement flow...');
        return await billingFlow.run({
            invoiceId: 'INV-2026-10',
            amount: 5000,
            currency: 'EUR',
        });
    }, 15000); // 15-second lock timeout
}

// 6. Graceful Shutdown
process.on('SIGTERM', async () => {
    await redis.quit();
    process.exit(0);
});
```
