# Siglo Ecosystem Adapters Matrix

Quick reference of all integration packages, their primary functions, dependencies, and environment requirements.

| Package                | Purpose                                            | Key Exports                                                   | Peer Dependencies           |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------- | --------------------------- |
| `@siglo/express`       | Express.js middleware with status translation      | `sigloExpressMiddleware`, `getErrorStatusCode`                | `express` ^4.18.0 or ^5.0.0 |
| `@siglo/fastify`       | Fastify route handler plugin                       | `sigloFastifyPlugin`                                          | `fastify` ^4.0.0 or ^5.0.0  |
| `@siglo/hono`          | Edge-ready middleware for Cloudflare/Bun/Node      | `sigloHonoMiddleware`                                         | `hono` ^4.0.0               |
| `@siglo/bullmq`        | Background worker queue consumer                   | `createBullMQProcessor`                                       | `bullmq` ^5.0.0, `ioredis`  |
| `@siglo/kafka`         | Apache Kafka consumer & event streaming            | `createKafkaConsumer`                                         | `kafkajs` ^2.0.0            |
| `@siglo/sqs`           | AWS SQS batch consumer with Lambda partial failure | `createSqsBatchHandler`                                       | `@aws-sdk/client-sqs`       |
| `@siglo/ai`            | Multi-provider LLM steps with structured outputs   | `aiStep`, `AiOutputValidationError`                           | `@siglo/http`               |
| `@siglo/http`          | Resilient HTTP client with egress network guards   | `httpStep`, `HttpStep`                                        | None (native fetch)         |
| `@siglo/notifications` | Slack / Email approval links & dispatch            | `sendInteractiveApprovalStep`, `sendNotificationStep`         | None                        |
| `@siglo/crypto`        | Timing-safe webhook check & envelope encryption    | `verifyWebhookStep`, `encryptFieldsStep`, `decryptFieldsStep` | None (native crypto)        |
| `@siglo/postgres`      | PostgreSQL persistence & OCC locking               | `PostgresStorageAdapter`, `PostgresIdempotencyStore`          | `pg` ^8.0.0                 |
| `@siglo/redis`         | Redis persistence, distributed locks, caching      | `RedisStorageAdapter`, `RedisLock`, `RedisNonceStore`         | `ioredis` ^5.0.0            |
| `@siglo/opentelemetry` | W3C distributed tracing spans                      | `registerOpenTelemetryPlugin`                                 | `@opentelemetry/api` ^1.9.0 |
| `@siglo/monitor`       | Real-time visual DevTools dashboard server         | `createMonitorServer`                                         | None                        |
| `@siglo/testing`       | Zero-flake workflow test harness & fake timers     | `createWorkflowHarness`, `FakeClock`, `replayExecution`       | None                        |
