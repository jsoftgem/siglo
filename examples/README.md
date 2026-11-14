node --import tsx examples/src/getting-started/checkout-demo.ts
node --import tsx --test examples/src/getting-started/checkout.test.ts
```

To call checkout over HTTP and inspect it in the dashboard, follow [REST Integration and Live Monitoring](../docs/rest-and-live-monitoring.md) and run `node --import tsx examples/src/getting-started/checkout-server.ts` after building `@siglo/express` and `@siglo/monitor`.

The demo shows a recovered payment failure and a shipping failure that triggers a refund and stock release. The tests also cover invalid input, permanent payment failure, and duplicate requests.

Continue with [Kafka Order Routing](../docs/kafka-order-routing.md) and the [ready-made two-consumer example](kafka-order-routing/README.md) to explore `@siglo/kafka`, shared `@siglo/postgres` idempotency, `branch`, and `when`.

Continue with [Correlate Distributed Multi-Domain Services](../docs/distributed-cross-service-workflows.md) and its [ready-made Docker example](distributed-cross-service-workflows/README.md) to explore multi-service microservice correlation with shared `stackId`, multi-tenant `namespace`, and combined live monitoring.

Continue with [Zero-Code APM Dashboards](../docs/zero-code-apm-dashboards.md) and its [self-contained example](zero-code-apm-dashboards/README.md) for traced publisher-to-worker execution and provisioned Grafana metrics. It runs independently of the Kafka routing tutorial.

---

## Architecture Overview
