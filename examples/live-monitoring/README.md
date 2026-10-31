# Siglo Live Monitoring Sample Project

A turnkey sample application demonstrating real-time workflow observability, dynamic DAG topology visualization, automated retry tracking, credential redaction, and interactive workflow resumption using `@siglo/monitor`.

---

## What This Sample Demonstrates

1. **DAG Graph Topology**: Automatic visualization of a multi-stage order processing pipeline:
   `fetchCustomer` &rarr; `assessRiskScore` &rarr; `applyVipDiscount` &rarr; `chargeCreditCard` &rarr; `awaitHumanApproval` &rarr; `finalizeFulfillment`
2. **Transient Error Retries**: `assessRiskScore` simulates a transient HTTP 503 error, demonstrating automated retry attempts, retry indicators in the UI (🔁 `retry(2)`), and retry counts in Prometheus metrics.
3. **Conditional Step Skipping**: `applyVipDiscount` is evaluated conditionally via `onBefore` and marked as ⚪ `SKIPPED` on standard orders and 🟢 `COMPLETED` on VIP orders.
4. **Credential Redaction**: `authToken` and `cardNumber` are dynamically masked with `[REDACTED]` in live SSE and WebSocket streams.
5. **Durable Suspension & Resumption**: Execution pauses at `awaitHumanApproval` using `waitForEvent('order.approved')` and is subsequently unblocked via `resumeWorkflow`.
6. **Prometheus Metrics**: Live metrics exported on `/metrics` (`siglo_active_flows`, `siglo_step_retries_total`, `siglo_flow_duration_seconds`).

---

## Running the Sample

From the repository root:

```bash
# Start the live monitoring demo
npm start --workspace=siglo-live-monitoring-sample
```

Or from within `examples/live-monitoring`:

```bash
cd examples/live-monitoring
npm start
```

### Endpoints
- **Web DevTools Dashboard**: [http://localhost:4000/](http://localhost:4000/)
- **Live SSE Event Stream**: [http://localhost:4000/events](http://localhost:4000/events)
- **WebSocket Protocol**: `ws://localhost:4000/ws`
- **Prometheus Metrics**: [http://localhost:4000/metrics](http://localhost:4000/metrics)

---

## Exploring the DevTools UI

1. Open `http://localhost:4000` in your web browser.
2. In the left sidebar, click on **ORD-101** or **ORD-202** to inspect execution state.
3. Observe:
   - **DAG Topology**: Nodes transition live from ⚪ *Pending* &rarr; 🔵 *Running* &rarr; 🟢 *Completed* / 🟡 *Suspended*.
   - **Latency Waterfall**: Inspect latency duration bars and retry counts per step.
   - **Context & State Diff**: Inspect context state mutations with redacted tokens.
   - **Interactive Resumption**: For suspended workflows, use the modal or trigger automated resumption.
