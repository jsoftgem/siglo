# Architecture & Security Challenge: Siglo Runtime (Grill-Me)

> Rigorous technical interrogations, distributed failure mode analyses, concurrency hazards, zero-daemon operational paradoxes, and boundary vulnerabilities across the complete **Siglo** workflow engine and ecosystem.

---

## Executive Context

**Siglo** positions itself as a *lightweight, zero-daemon, in-process workflow orchestrator* for TypeScript. It offers:
1. **Durable Checkpointing & Event Resumption** (`waitForEvent`, `wait`, OCC storage)
2. **Sagas & LIFO Compensations** (`step.compensate`, `flow.compensate`)
3. **Structured Concurrency Combinators** (`parallel`, `branch`, `map`, `race`, `allSettled`)
4. **Declarative Network Egress Guardrails** (`AsyncLocalStorage`, monkey-patched HTTP/fetch/Socket)
5. **Scoped Idempotency & Claim Locking** (`IdempotencyStore`, PostgreSQL, Redis)
6. **Live DevTools & Telemetry** (`@siglo/monitor`, WebSockets, SSE, interactive resumption)

While all test suites pass with 100% code coverage, **mission-critical enterprise workflows** (financial ledgers, multi-tenant SaaS, healthcare, and high-throughput microservices) inevitably hit the harsh realities of distributed systems: network partitions, out-of-order deliveries, split-brain executions, container crashes, and security boundary evasions.

The following **6 Architectural & Security Challenge Rounds** evaluate the overall Siglo project against enterprise production realities.

---

## Round 1: The "Zero-Daemon" Paradox & Resumption Split-Brain

### 1. The Operational Dilemma
Siglo markets itself as **zero-daemon** (requiring no external cluster coordinator, worker daemon, or Temporal/Cadence engine), yet provides durable long-running steps:
```typescript
waitForEvent('PAYMENT_CONFIRMED', { timeout: '30d' })
wait('12h')
```
If a Kubernetes pod, ECS task, or serverless container executing a workflow restarts, crashes (OOM/SIGKILL), or deploys a new image while 5,000 workflows are suspended in PostgreSQL:
1. **Who wakes up the sleeping workflows?** In-process timers (`setTimeout`) die with the process. Without an external poller or queue daemon, time-based durables become permanent zombie workflows in the database.
2. **Dual-Worker Resumption Race**: Consider two active worker instances behind a load balancer. When a webhook arrives to resume a correlation key, both Worker A and Worker B hit [`resumeWorkflow`](packages/core/src/features/durable/resume.ts):
```typescript
const waitRecord = defaultDurableManager.resumeWait(correlationKey);
// ...
const resumedFlow = flow(...remainingSteps);
return resumedFlow.execute(cleanInput, effectiveOptions);
```
`defaultDurableManager` is an **in-memory Map**. If Worker A and Worker B receive the resume event within the same network window, both fetch the checkpoint, both resume the wait record, and both execute the remaining steps.

### 2. Checkpoint Archeology & Context Flattening
In [`resumeWorkflow`](packages/core/src/features/durable/resume.ts):
```typescript
let restoredState: any = cp?.contexts ? Object.assign({}, ...Object.values(cp.contexts)) : {};
const mergedInput = Object.assign({}, restoredState, eventPayload);
```
- **Shallow Overwrite**: If earlier steps returned structured nested keys (e.g. `Step1: { meta: { a: 1 } }` and `Step2: { meta: { b: 2 } }`), `Object.assign` performs a shallow merge, destroying `meta.a`.
- **Iteration Order Non-Determinism**: `Object.values(cp.contexts)` relies on JavaScript property iteration order of serialized checkpoints.
- **Lost `$steps` Typed History**: Downstream steps expecting `ctx.$steps.stepA.result` crash on resumption because `$steps` is not reconstructed from `cp.contexts`.

### Key Questions to Address
- Without a background polling daemon, how can Siglo guarantee that `wait('12h')` resumes on time if the originating node restarts?
- Why is there no distributed compare-and-swap / atomic claim lock (`UPDATE siglo_wait_records SET status = 'RESUMED' WHERE status = 'WAITING'`) in `resumeWorkflow` to prevent duplicate parallel execution?
- How should checkpoint hydration faithfully reconstruct the accumulated context and `$steps` history without shallow flattening bugs?

---

## Round 2: The Phantom Saga & Silent Compensation Drops

### 1. The Failure Scenario
Siglo implements Sagas via [`step.compensate(handler)`](packages/core/src/features/step/index.ts) and executes them in reverse LIFO order. 

In `packages/core/src/features/step/index.ts` (lines 504–525), compensation rehydration from checkpoints works as follows:
```typescript
const allSteps = flattenSteps(flowObj.steps || []);
for (const record of serializedCompensations) {
    const matchingStep = allSteps.find((s: any) =>
        (s?.name && s.name === record.stepName) ||
        (s?.$stepId && s.$stepId === record.stepId)
    );
    if (matchingStep?.compensationHandler) {
        defaultCompensationManager.registerCompensation(stackId, { ... });
    }
}
```

### 2. The Vulnerability
1. **Dynamic Workflows & Code Evolution**: If a service deploys a new version where a step was renamed, refactored, or replaced, `matchingStep` is `undefined`. The compensation handler is **silently ignored**, and `runCompensations` proceeds without rolling back the external resource (e.g., flight booking remains active, money is charged, but inventory is cancelled).
2. **Combinator Opacity**: `flattenSteps` cannot inspect dynamic branches, conditional functions, or closures inside custom steps or nested flows.
3. **The Unhandled Node Crash**: In Temporal, an orchestrator daemon detects worker heartbeat timeouts and dispatches compensations to surviving workers. In Siglo, if a Node process crashes mid-flight after executing 3 out of 5 steps, **who triggers `flow.compensate(stackId)`?** The database checkpoint records the incomplete stack, but compensations never run unless an engineer manually builds custom watchdog tooling.
4. **Compensation Failure Deadlocks**: In [`runCompensations`](packages/core/src/features/compensation/manager.ts), if a compensation step exhausts retries and fails, it throws `CompensationException`. Does Siglo support compensation dead-letter queues (DLQs) or manual administrative reconciliation endpoints?

### Key Questions to Address
- How do you guarantee compensation durability across code version deployments when compensation handlers are in-memory closures?
- What is the operational runbook for unhandled process crashes mid-saga in a zero-daemon architecture?
- How should the engine handle partial compensation failures without stranding dependent transactions in an indeterminate state?

---

## Round 3: Concurrency Combinators & Non-Deterministic Merge Races

### 1. The Race Condition in `parallel`
In [`packages/core/src/features/combinators/parallel.ts`](packages/core/src/features/combinators/parallel.ts), the default `fail-fast` mode executes branches:
```typescript
const branchOutputs: Array<{ name: string; output: any }> = [];
const branchPromises = branches.map(async (branch, index) => {
    // ...
    const out = await executeBranch(branch, param, combinedSignal);
    branchOutputs.push({ name: bName, output: cleaned });
    return cleaned;
});
await Promise.all(branchPromises);

// In default 'shallow' merge strategy:
for (const b of branchOutputs) {
    if (b.output && typeof b.output === 'object') {
        Object.assign(merged, b.output);
    }
}
```

### 2. The Flaw
- `branchOutputs.push(...)` executes in **completion order**, NOT definition order.
- Whichever branch finishes last calls `Object.assign(merged, b.output)` last.
- If Branch A and Branch B output different values for the same property, the winning value is **entirely non-deterministic**, dictated by network I/O jitter and microtask scheduling.
- In `deepMerge` (lines 60–72), arrays are not merged (`!Array.isArray(sVal)`): if Branch A returns `{ tags: ['a'] }` and Branch B returns `{ tags: ['b'] }`, one array completely replaces the other.

### 3. The `toPOJO` Side-Effect Hazard
In [`packages/core/src/features/context/proxy.ts`](packages/core/src/features/context/proxy.ts):
```typescript
if (typeof data[key] === 'function') {
    if (data[key].val !== undefined) {
        val = data[key].val;
    } else if (data[key].length === 0) {
        try {
            val = data[key]();
        } catch {
            val = data[key];
        }
    }
}
```
If any object in the context graph contains a zero-argument function—such as a database connection cleanup `ctx.db.close()`, a token generator `ctx.auth.refreshToken()`, or a socket shutdown method—**`toPOJO` automatically executes it** during context cloning and checkpoint serialization.

### Key Questions to Address
- Why does `parallel` merge branches in arrival order rather than indexed declaration order?
- Why does `toPOJO` execute arbitrary 0-arity functions found on context properties, and what are the security/operational risks when user data contains methods?
- When `AbortController.abort()` fires, how does Siglo handle uncooperative native third-party libraries (e.g. database drivers without signal support) that continue consuming pool connections?

---

## Round 4: Network Egress Guardrails & Perimeter Bypasses

### 1. Perimeter Architecture
Siglo enforces network egress policies using `AsyncLocalStorage` and monkey-patching `globalThis.fetch`, `http.request`, `https.request`, and `net.Socket.prototype.connect` in [`interceptor.ts`](packages/core/src/features/network/interceptor.ts).

### 2. The Vulnerabilities
1. **DNS Rebinding & SSRF Exploits**:
   [`isHostAllowed`](packages/core/src/features/network/matcher.ts) validates the hostname string (e.g. `api.partner.com`) against allowed patterns. However, DNS resolution occurs **after** policy validation. An attacker controlling `partner.com` can return an `A` record pointing to AWS/GCP instance metadata (`169.254.169.254`) or internal VPC endpoints (`10.0.0.1`). Siglo never validates the resolved IP address at the socket level.
2. **Default Localhost Exemption & Container Escape**:
   `allowLocalhost` defaults to `true` ([`matcher.ts#L167`](packages/core/src/features/network/matcher.ts)). In [`isLocalhost`](packages/core/src/features/network/matcher.ts):
   ```typescript
   if (clean.startsWith('unix:') || clean.startsWith('/') || clean.includes('.sock')) {
       return true;
   }
   ```
   All Unix domain sockets are unconditionally allowed by default. Any step with outbound network access can connect directly to `/var/run/docker.sock` or local container daemon IPC sockets to achieve host compromise.
3. **Alternative IP Encoding Bypasses**:
   `isLocalhost` only checks string literals `'127.0.0.1'`, `'localhost'`, `'::1'`. Hexadecimal (`0x7f000001`), decimal integer (`http://2130706433`), octal, or IPv6-mapped IPv4 (`[::ffff:127.0.0.1]`) evade string checks while Node.js connects to localhost.
4. **HTTP 30x Redirect Bypass**:
   When `patchedFetch` allows a call to a whitelisted domain, the target server can respond with `302 Found` redirecting to `http://169.254.169.254/latest/meta-data/`. The underlying fetch engine follows the redirect internally without re-invoking `isHostAllowed`.
5. **`BlockedClientRequest` Prototype Skew**:
   [`BlockedClientRequest`](packages/core/src/features/network/interceptor.ts) does not extend `http.ClientRequest`. Libraries like `axios`, `got`, or `undici` that perform `instanceof http.ClientRequest` assertions fail with unhandled TypeError exceptions instead of a clean `NetworkPolicyViolationException`.

### Key Questions to Address
- How can Siglo defend against DNS rebinding without performing DNS resolution within the interceptor and pinning socket connections to validated IP addresses?
- Why are Unix domain sockets (including container control sockets) exempted under `allowLocalhost` by default?
- How does the network interceptor enforce redirect boundary traversal?

---

## Round 5: Idempotency Lock Storms & The OCC Illusion

### 1. The PostgreSQL "OCC Illusion"
The documentation promises **Optimistic Concurrency Control (OCC)** for checkpoint integrity. However, inspecting [`PostgresStorageAdapter.saveCheckpoint`](packages/postgres/src/adapter.ts):
```sql
INSERT INTO siglo_checkpoints (stack_id, namespace, state, updated_at)
VALUES ($1, $2, $3::jsonb, NOW())
ON CONFLICT (stack_id)
DO UPDATE SET state = EXCLUDED.state, namespace = EXCLUDED.namespace, updated_at = NOW()
```
There is **no version check** (`WHERE version = $currentVersion`). It performs an unconditional blind overwrite. If two nodes resume or update the same stack concurrently, the last write wins, silently obliterating intermediate states and violating OCC guarantees.

### 2. Idempotency Lock Contention & DLQ Storms
In [`runner.ts`](packages/core/src/features/executer/runner.ts):
```typescript
if (claim === Status.IN_PROGRESS) {
    throw new IdempotencyConflictException(idempotencyKeyScoped, { stackId, namespace });
}
```
When duplicate messages arrive concurrently in event-driven systems (Kafka consumer groups, SQS FIFO, or rapid webhook retries):
- Siglo **immediately aborts** the second execution with an exception.
- It does not wait, spin-lock, or poll for the in-flight workflow to complete and yield its cached result.
- In HTTP APIs, clients receive an immediate 409 error. In SQS or Kafka, messages fail immediately and cycle into Dead Letter Queues (DLQs) instead of waiting for the original claim to settle.

### 3. Fail-Open Key Deletion on Error
In [`InMemoryIdempotencyStore.fail`](packages/core/src/features/idempotency/store.ts) and [`PostgresIdempotencyStore.fail`](packages/postgres/src/idempotency.ts):
```typescript
async fail(key: string, _error: unknown): Promise<void> {
    this.records.delete(key);
}
```
If a workflow fails due to a **non-retryable fatal business error** (e.g. CardDeclined, InvalidAccount, FraudDetected), Siglo immediately deletes the key. Any retried request re-claims the key and re-executes against payment gateways or third-party APIs instead of returning the cached rejection.

### Key Questions to Address
- Why is PostgreSQL checkpoint persistence implemented as an unconditional upsert rather than strict OCC (`UPDATE ... WHERE stack_id = $1 AND version = $expectedVersion`)?
- Why does `IdempotencyStore` lack a bounded wait-and-settle mechanism (`pollUntilSettled(key, timeoutMs)`) before failing duplicate requests?
- How should idempotency stores differentiate between transient infrastructure retries and permanent business failures?

---

## Round 6: Live DevTools Control Plane & Context Exfiltration

### 1. Control Plane Architecture
[`@siglo/monitor`](packages/monitor/src/server.ts) exposes a web DevTools UI, SSE/WebSocket telemetry streaming, Prometheus metrics, and remote workflow resumption endpoints (`/api/workflows/:id/resume`).

### 2. The Vulnerabilities
1. **Unchecked Payload Injection on Remote Resume**:
   In [`server.ts`](packages/monitor/src/server.ts):
   ```typescript
   const parsed = body ? JSON.parse(body) : {};
   const targetFlow = options.flow || workflows.get(stackId) || workflows.get("default");
   await resumeWorkflow(targetFlow, stackId, parsed.payload, { monitor: emitter });
   ```
   The endpoint accepts arbitrary JSON from HTTP/WebSocket callers and forwards it directly into `resumeWorkflow`, which shallow-merges it into the workflow context without schema validation (`mergedInput = Object.assign({}, restoredState, eventPayload)`).
2. **Workflow Routing Cross-Talk**:
   If `options.flow` is registered or a `"default"` workflow exists, any resume request for an unknown `stackId` defaults to running that `"default"` flow. Resuming a KYC workflow checkpoint inside an Order Processing flow leads to state corruption or unintended side effects.
3. **Plaintext Context Leakage over WebSockets**:
   Step completion events broadcast the entire accumulated context across WebSockets and SSE to all connected dashboard clients. If workflows handle SSNs, credit card numbers, or auth tokens, these are broadcast in plaintext unless the developer manually wraps every step with `@siglo/crypto` masking.
4. **Unbounded In-Memory Telemetry Growth**:
   In `WorkflowExecutionStore`, runs and step traces are stored in memory. In high-throughput production (10,000+ executions/min), does the monitor server impose ring-buffer limits, or will it cause Node heap exhaustion and crash the host process?

### Key Questions to Address
- How should the DevTools monitor server enforce strict schema validation on remote resume payloads before mutating context?
- Why is there fallback execution to `"default"` workflows when a stack ID does not match the registered flow?
- How should real-time monitoring streams automatically enforce field-level redaction for sensitive context keys?

---

## Summary Matrix

| Round | Focus Area | Critical Failure Mode | Architectural Trade-Off |
|---|---|---|---|
| **1** | **Durable Resumption** | Dual-worker resume races & sleeping workflow abandonment without daemons | Pure in-process simplicity vs. Distributed atomic claims & cluster coordination |
| **2** | **Sagas & Compensations** | Silent drop of compensations across code deployments; unhandled node crashes | Dynamic runtime inference vs. Deterministic compensation registries & DLQs |
| **3** | **Concurrency Combinators** | Non-deterministic merge race conditions in `parallel`; `toPOJO` 0-arg function execution | Shallow performance speed vs. Indexed deterministic merging & safe serialization |
| **4** | **Network Guardrails** | DNS rebinding SSRF, default Docker socket access, and 30x redirect bypasses | Userland AsyncLocalStorage interceptors vs. Kernel/OS-level egress sandboxing |
| **5** | **Storage & Idempotency** | Missing version checks in PostgreSQL (OCC illusion); fail-open key deletion | Unconditional SQL upserts vs. Strict OCC versioning & settlement spin-locks |
| **6** | **DevTools & Control** | Unvalidated remote resume payload injection and plaintext context broadcast | Zero-friction developer ergonomics vs. Hardened RBAC, schema guards, & telemetry sanitization |
