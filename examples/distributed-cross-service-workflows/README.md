# Distributed Multi-Domain Services Workflow

Run distributed microservices workflows correlated by [`stackId`](../../docs/api/execution-options.md#stackid) and tenant [`namespace`](../../docs/api/execution-options.md#namespace) using the **Parent-Child Correlated Workflows** pattern with separate, connected DAGs in Siglo Live Monitoring.

---

## Services & Ports

| Service | Local Address | Purpose |
| :--- | :--- | :--- |
| **Order Service** (Service A) | `http://127.0.0.1:3001` | Ingests orders, runs the Order workflow, and invokes fulfillment over HTTP with correlated child `x-stack-id` & `x-tenant-id` |
| **Fulfillment Service** (Service B) | `http://127.0.0.1:3002` | Handles inventory, payment, and shipping workflows with its own connected DAG |
| **Live Monitoring Dashboard** | `http://127.0.0.1:4200` | Real-time React dashboard with live events, connected DAGs, and tenant filter |
| **Redis** | `127.0.0.1:6383` | Pub/Sub backbone transporting workflow lifecycle events to the live monitor |

---

## Quick Start with Docker Compose

From the **repository root**:

```bash
docker compose -f examples/distributed-cross-service-workflows/docker-compose.yml up --build -d --wait
```

### 1. Dispatch Distributed Orders

Run the smoke script or use `curl`:

```bash
./examples/distributed-cross-service-workflows/smoke.sh
```

Or trigger manually:

```bash
# Tenant A: tenant_acme_retail
curl -i -X POST http://127.0.0.1:3001/api/orders \
  -H "Content-Type: application/json" \
  -H "x-stack-id: stack-acme-order-101" \
  -H "x-tenant-id: tenant_acme_retail" \
  -d '{"orderId":"ORD-ACME-001","sku":"mechanical-keyboard-rgb","quantity":2,"amountCents":15998,"customerEmail":"buyer@acme.com"}'

# Tenant B: tenant_globex_corp
curl -i -X POST http://127.0.0.1:3001/api/orders \
  -H "Content-Type: application/json" \
  -H "x-stack-id: stack-globex-order-202" \
  -H "x-tenant-id: tenant_globex_corp" \
  -d '{"orderId":"ORD-GLOBEX-002","sku":"datacenter-switch-48p","quantity":1,"amountCents":850000,"customerEmail":"procure@globex.com"}'
```

### 2. Inspect Live Monitoring

1. Open **`http://127.0.0.1:4200`** in your browser.
2. Filter by tenant using the **Tenant dropdown** (`tenant_acme_retail` or `tenant_globex_corp`).
3. Type **`stack-acme-order-101`** in the search bar:
   - Notice that **both** `order-processing-service` (`stack-acme-order-101`) and `fulfillment-service` (`stack-acme-order-101:fulfillment`) appear in the Run List!
4. Click **`order-processing-service`** to view its connected 4-step Order graph:
   - Click the step `order:dispatchToFulfillment` to see the inspectable `childWorkflow` output linking to the child fulfillment stack.
5. Click **`fulfillment-service`** to view its own connected 4-step Fulfillment graph (no steps dumped into "Other observed steps").

### 3. Stop the Containers

```bash
docker compose -f examples/distributed-cross-service-workflows/docker-compose.yml down
```

---

## Direct Host Workflow (Without Docker)

You can also run the complete demo directly on your host machine:

```bash
cd examples
npm run demo:distributed-domains
```
