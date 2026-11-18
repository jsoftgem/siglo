# @siglo/query

Storage-agnostic workflow query engine, GraphQL schema & resolvers, real-time SSE/WebSocket subscriptions, drop-in web framework route handlers (Express, Fastify, Hono), and Model Context Protocol (MCP) server for [Siglo](https://github.com/jsoftgem/siglo) workflows.

## Installation

```bash
npm install @siglo/query @siglo/core graphql
```

## Quick Start

### 1. Programmatic Query Engine

```typescript
import { createWorkflowQueryEngine } from '@siglo/query';
import { defaultStorageManager } from '@siglo/core';

const engine = createWorkflowQueryEngine({
    storage: defaultStorageManager.getAdapter(),
    redactFields: ['apiKey', 'password', 'token', 'secret'],
});

const page = await engine.findMany({
    filter: { namespace: 'tenant-acme', status: 'running' },
    pagination: { limit: 20 },
});
```

### 2. Web Framework Route Mounts

```typescript
import express from 'express';
import { createExpressQueryMiddleware } from '@siglo/query';

const app = express();
app.use(express.json());
app.use(
    '/graphql',
    createExpressQueryMiddleware({
        engine,
        namespace: req => req.headers['x-tenant-id'],
    }),
);
```

### 3. Model Context Protocol (MCP) Server (`@siglo/query/mcp`)

```typescript
import { createWorkflowMcpServer } from '@siglo/query/mcp';
import { defaultStorageManager } from '@siglo/core';

const mcpServer = createWorkflowMcpServer({
    storage: defaultStorageManager.getAdapter(),
    namespace: 'tenant-acme',
    redactFields: ['apiKey', 'password', 'token', 'secret'],
    transport: 'stdio',
});

await mcpServer.start();
```

## License

MIT
