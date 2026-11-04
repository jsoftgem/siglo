# Siglo Live Monitoring & Express API Sample Project

A turnkey sample application demonstrating real-time workflow observability, dynamic DAG topology visualization, automated retry tracking, credential redaction, interactive workflow resumption using `@siglo/monitor`, and live workflow execution via Express REST API using `@siglo/express`.

---

## What This Sample Demonstrates

1. **DAG Graph Topology**: Automatic visualization of a multi-stage order processing pipeline:
   `fetchCustomer` &rarr; `assessRiskScore` &rarr; `applyVipDiscount` &rarr; `chargeCreditCard` &rarr; `awaitHumanApproval` &rarr; `finalizeFulfillment`
2. **Transient Error Retries**: `assessRiskScore` simulates a transient HTTP 503 error, demonstrating automated retry attempts, retry indicators in the UI (🔁 `retry(2)`), and retry counts in Prometheus metrics.
3. **Conditional Step Skipping**: `applyVipDiscount` is evaluated conditionally via `onBefore` and marked as ⚪ `SKIPPED` on standard orders and 🟢 `COMPLETED` on VIP orders.
4. **Credential Redaction**: `authToken` and `cardNumber` are dynamically masked with `[REDACTED]` in live SSE and WebSocket streams.
5. **Durable Suspension & Resumption**: Execution pauses at `awaitHumanApproval` using `waitForEvent('order.approved')` and is subsequently unblocked via `resumeWorkflow`.
6. **Prometheus Metrics**: Live metrics exported on `/metrics` (`siglo_active_flows`, `siglo_step_retries_total`, `siglo_flow_duration_seconds`).
7. **HTTP Workflow Execution API (`@siglo/express`)**: Live REST API endpoints exposing the workflow with automatic header injection (`X-Workflow-Stack-Id`, `X-Correlation-Id`), multi-tenant routing (`X-Namespace`), and typed request/response mappings.

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
- **Order Execution API (Express)**: `POST http://localhost:4000/api/orders`
- **Order Approval API (Express)**: `POST http://localhost:4000/api/orders/:orderId/approve`
- **Dedicated Express Port (Optional)**: `http://localhost:3000/api/orders` (via `API_PORT=3000`)

---

## Triggering Workflow Executions via Express API

### 1. Execute a Standard Order
```bash
curl -i -X POST http://localhost:4000/api/orders \
  -H "Content-Type: application/json" \
  -H "X-Correlation-Id: req-order-101" \
  -H "X-Namespace: ecommerce-retail" \
  -d '{
    "orderId": "ORD-LIVE-101",
    "customerId": "cust_alice",
    "amount": 150,
    "authToken": "secret-jwt-token-xyz",
    "cardNumber": "4111-2222-3333-4444",
    "isVip": false
  }'
```

Response:
```json
HTTP/1.1 201 Created
X-Correlation-Id: req-order-101
X-Workflow-Stack-Id: c89456...

{
  "success": true,
  "orderId": "ORD-LIVE-101",
  "fulfillmentStatus": "DISPATCHED",
  "trackingNumber": "TRK-USPS-732941",
  "customerTier": "STANDARD",
  "riskScore": 12,
  "netCharged": 150,
  "discountApplied": false,
  "region": "US-EAST"
}
```

### 2. Execute a VIP Order with Discount
```bash
curl -i -X POST http://localhost:4000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "ORD-VIP-202",
    "customerId": "cust_bob",
    "amount": 800,
    "authToken": "vip-secret-token",
    "cardNumber": "5500-1111-2222-3333",
    "isVip": true
  }'
```

### 3. Execute Durable Order with Human Approval Suspension
```bash
curl -i -X POST http://localhost:4000/api/orders \
  -H "Content-Type: application/json" \
  -H "X-Durable: true" \
  -d '{
    "orderId": "ORD-HOLD-303",
    "customerId": "cust_charlie",
    "amount": 2500,
    "authToken": "audit-token",
    "cardNumber": "3700-1111-2222-3333",
    "isVip": true
  }'
```

Response (HTTP 202 Accepted):
```json
HTTP/1.1 202 Accepted
X-Workflow-Stack-Id: d4a789...

{
  "status": "SUSPENDED",
  "stackId": "d4a789...",
  "correlationKey": "ORD-HOLD-303",
  "waitingForEvent": "order.approved",
  "message": "Workflow suspended waiting for 'order.approved'. Approve via POST /api/orders/ORD-HOLD-303/approve"
}
```

Approve and Resume via API:
```bash
curl -i -X POST http://localhost:4000/api/orders/ORD-HOLD-303/approve \
  -H "Content-Type: application/json" \
  -d '{
    "approvedBy": "risk-officer@corp.internal",
    "decisionNotes": "Verified creditworthiness and high-value tier"
  }'
```

---

## Exploring the DevTools UI

1. Open `http://localhost:4000` in your web browser.
2. In the left sidebar, click on any executed order (e.g. **ORD-101**, **ORD-202**, or newly posted API orders) to inspect execution state.
3. Observe:
   - **DAG Topology**: Nodes transition live from ⚪ *Pending* &rarr; 🔵 *Running* &rarr; 🟢 *Completed* / 🟡 *Suspended*.
   - **Latency Waterfall**: Inspect latency duration bars and retry counts per step.
   - **Context & State Diff**: Inspect context state mutations with redacted tokens.
   - **Interactive Resumption**: For suspended workflows, use the modal or trigger automated resumption.
