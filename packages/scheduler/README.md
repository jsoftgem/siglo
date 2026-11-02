# @siglo/scheduler

> Background timer polling, distributed lock claiming, and cloud-native webhook dispatchers for Siglo durable workflows.

[![NPM Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://www.npmjs.com/package/@siglo/scheduler)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Features

- **PostgresWaitPoller**: Row-level locking daemon (`FOR UPDATE SKIP LOCKED`) claiming due wait records in `siglo_wait_records` without split-brain races.
- **MemoryWaitPoller**: Zero-daemon poller for in-memory and local development environments.
- **CloudSchedulerWebhookHandler**: Cloud-native webhook handler for serverless event dispatchers (AWS EventBridge Scheduler, Google Cloud Tasks, Cloudflare Queues).
- **Graceful Lifecycle**: Bounded polling loops with cooperative cancellation and `SIGTERM` handlers.

---

## Installation

```bash
npm install @siglo/scheduler siglo @siglo/postgres pg
```

---

## Quickstart

### 1. PostgreSQL Background Poller Daemon

```typescript
import { Pool } from 'pg';
import { PostgresWaitPoller } from '@siglo/scheduler';
import { myFlow } from './workflows';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const poller = new PostgresWaitPoller({
    client: pool,
    pollIntervalMs: 1000,
    batchSize: 50,
    lockTimeoutMs: 60000,
    flowLookup: (workflowId, stackId) => myFlow
});

// Ensure tables exist and start poller loop
await poller.ensureTable();
poller.start();

process.on('SIGTERM', async () => {
    await poller.stop();
    await pool.end();
    process.exit(0);
});
```

### 2. Cloud Webhook Dispatcher (AWS EventBridge / GCP Cloud Tasks)

```typescript
import http from 'http';
import { createSchedulerWebhookHandler } from '@siglo/scheduler';
import { myFlow } from './workflows';

const handler = createSchedulerWebhookHandler({
    secretToken: process.env.SCHEDULER_SECRET_TOKEN,
    flowLookup: () => myFlow
});

http.createServer(handler).listen(8080);
```

---

## Documentation

For full operational runbooks and schema migration guides, see the [Scheduler Adapter Documentation](../../docs/adapters/scheduler.md).

---

## License

MIT © Jerico de Guzman
