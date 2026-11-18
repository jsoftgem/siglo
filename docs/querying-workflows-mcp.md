---
title: 'Querying & Diagnosing Workflows with MCP and AI Agents'
description: 'Connect Claude Desktop, Cursor, and IDE AI assistants to Siglo workflows using the @siglo/query/mcp Model Context Protocol server.'
---

# Querying & Diagnosing Workflows with MCP and AI Agents

For GraphQL HTTP/SSE setup, see [Querying Workflows with GraphQL and React DevTools](/querying-workflows-graphql) and the [@siglo/query Adapter Guide](/adapters/query).

As durable workflows scale in production, developers and on-call operators need a fast, safe way to ask questions in natural language—such as *"Why did order 101 fail this morning?"* or *"Which checkout workflows are currently waiting on manager approval?"*—without writing ad-hoc SQL queries or exposing raw database credentials and customer secrets to LLMs.

`@siglo/query/mcp` provides a built-in **Model Context Protocol (MCP) Server** that connects any MCP-compatible AI assistant (Claude Desktop, Cursor, VS Code, JetBrains AI, Antigravity, or custom agents) directly to your Siglo workflow storage over `stdio` or HTTP Server-Sent Events (`sse`).

---

## 1. Why `@siglo/query/mcp`?

Feeding raw workflow checkpoints directly into an LLM context window creates three major problems:
1. **Token Exhaustion**: A 10-step workflow with full step outputs and compensation logs can exceed 50,000 tokens per execution.
2. **Credential & PII Leakage**: Unredacted API keys, tokens, or passwords stored in step contexts enter the LLM transcript.
3. **Cross-Tenant Data Exposure**: Unscoped queries risk mixing executions across tenant namespaces.

`@siglo/query/mcp` acts as an intelligent projection and security gateway:
- **Summaries First**: `search_workflows` and `siglo://workflows/active` omit heavy context JSONB blobs, returning compact ~100-token execution summaries.
- **Targeted Context Paths**: `inspect_workflow` supports dot-path extraction (`contextPath: "payment.card"`) so the LLM only loads the slice of state it needs.
- **Enforced Secret Redaction**: All sensitive fields (`apiKey`, `password`, `token`, `secret`, plus custom `redactFields`) are scrubbed to `"[REDACTED]"` before leaving the server. Even in `execute_workflow_query`, `redact: false` is blocked at the GraphQL AST layer.
- **Tenant Isolation**: When `namespace` is configured on the MCP server, all tool calls, resources, and prompts are strictly locked to that tenant.

```mermaid
sequenceDiagram
    actor Dev as Developer / Operator
    participant Agent as AI Assistant (Claude / Cursor / IDE)
    participant MCP as @siglo/query/mcp Server
    participant Engine as WorkflowQueryEngine
    participant DB as @siglo/postgres / Storage

    Dev->>Agent: "Why did order 101 fail this morning?"
    Agent->>MCP: callTool("search_workflows", { metadataFilter: { orderId: "101" } })
    MCP->>Engine: findMany({ select: { includeContext: false } })
    Engine->>DB: Indexed query (omits heavy context JSONB)
    DB-->>Engine: Summary row
    Engine-->>MCP: { stackId: "stack-order-101", status: "FAILED" }
    MCP-->>Agent: Lightweight summary match

    Agent->>MCP: callTool("inspect_workflow", { stackId: "stack-order-101", includeSteps: true })
    MCP->>Engine: findById("stack-order-101", { redact: true })
    Engine->>DB: Load checkpoint & step diagnostics
    DB-->>Engine: Checkpoint with failedStep & error
    Engine-->>MCP: Redacted context + Step "chargeStripe" threw CardExpiredException
    MCP-->>Agent: Redacted diagnostic payload

    Agent-->>Dev: "Order 101 (stack-order-101) failed at step 'chargeStripe' with CardExpiredException."
```

---

## 2. Installation

Install `@siglo/query`, `@siglo/core`, `graphql`, and `@modelcontextprotocol/sdk`:

```bash
npm install @siglo/query @siglo/core @modelcontextprotocol/sdk graphql
```

If persisting workflows in PostgreSQL:

```bash
npm install @siglo/postgres pg
```

---

## 3. Step 1: Create the MCP Server Entrypoint

Create `mcp-server.ts` in your project. You can run it in **`stdio` mode** (for local desktop/IDE assistants) or **`sse` mode** (for remote/shared environments):

```typescript
import { Pool } from 'pg';
import { defaultStorageManager } from '@siglo/core';
import { PostgresStorageAdapter } from '@siglo/postgres';
import { createWorkflowMcpServer } from '@siglo/query/mcp';
import { orderWorkflow } from './workflow';

async function main() {
    // 1. Configure your storage adapter (Postgres or MemoryStorageAdapter)
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
    });
    const storage = new PostgresStorageAdapter({ client: pool });
    await storage.ensureTables();

    // Register with defaultStorageManager so resume_workflow can execute continuations
    defaultStorageManager.useStorage(storage);

    // 2. Create the Siglo MCP server
    const transportMode = process.env.MCP_TRANSPORT === 'sse' ? 'sse' : 'stdio';

    const mcpServer = createWorkflowMcpServer({
        storage,
        // Lock this MCP server instance to a specific tenant namespace:
        namespace: process.env.SIGLO_NAMESPACE || 'store-tenant-1',
        // Scrub sensitive fields across all tools, resources, and prompts:
        redactFields: ['apiKey', 'password', 'token', 'secret', 'secretToken', 'cvv'],
        // Optional: provide workflow definitions so resume_workflow can run continuations:
        resolveWorkflow: (checkpoint) => {
            if (checkpoint.workflowId === 'order-flow') {
                return orderWorkflow;
            }
            return undefined;
        },
        transport: transportMode,
        sse: {
            port: Number(process.env.MCP_PORT || 4100),
            host: '127.0.0.1',
            ssePath: '/sse',
            messagePath: '/messages',
        },
    });

    await mcpServer.start();

    if (transportMode === 'sse') {
        console.error(`Siglo MCP SSE Server listening at ${mcpServer.getSseUrl()}`);
    }
}

main().catch((err) => {
    console.error('Failed to start Siglo MCP server:', err);
    process.exit(1);
});
```

> **Note**: When using `transport: 'stdio'`, always write application logs to `console.error` (`stderr`) rather than `console.log` (`stdout`) so JSON-RPC protocol frames on `stdout` are not corrupted.

---

## 4. Step 2: Connect Your AI Assistant or IDE

### Option A: Cursor (`.cursor/mcp.json`)

Add the server to `.cursor/mcp.json` in your repository root:

```json
{
  "mcpServers": {
    "siglo-workflows": {
      "command": "npx",
      "args": ["tsx", "mcp-server.ts"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/siglo",
        "SIGLO_NAMESPACE": "store-tenant-1"
      }
    }
  }
}
```

### Option B: Claude Desktop (`claude_desktop_config.json`)

Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "siglo-workflows": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/your-project/mcp-server.ts"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/siglo",
        "SIGLO_NAMESPACE": "store-tenant-1"
      }
    }
  }
}
```

### Option C: Remote HTTP SSE Connection

Start the server in SSE mode:

```bash
MCP_TRANSPORT=sse MCP_PORT=4100 npx tsx mcp-server.ts
```

Point any SSE-capable MCP client to:

```json
{
  "mcpServers": {
    "siglo-workflows-remote": {
      "url": "http://127.0.0.1:4100/sse"
    }
  }
}
```

---

## 5. Step 3: Using the MCP Tools

Once connected, your AI assistant discovers four tools automatically. Below is how each tool works and what parameters it accepts.

### 1. `search_workflows` — Find & Filter Executions

Use `search_workflows` to list workflows by status, workflow type, creation time window, or promoted metadata fields without loading heavy step contexts.

* **Example Natural Language Prompt**:
  > *"Show me the last 5 failed order-checkout workflows for order 101."*

* **Tool Arguments**:
  ```json
  {
    "workflowId": "order-checkout",
    "status": "FAILED",
    "metadataFilter": {
      "orderId": "101"
    },
    "limit": 5
  }
  ```

* **Tool Output**:
  ```json
  {
    "workflows": [
      {
        "stackId": "stack-order-101",
        "workflowId": "order-checkout",
        "namespace": "store-tenant-1",
        "status": "FAILED",
        "revision": 2,
        "createdAt": "2026-03-15T09:14:00.000Z",
        "updatedAt": "2026-03-15T09:14:02.000Z",
        "metadata": {
          "orderId": "101",
          "failedStep": "chargeStripe",
          "secret": "[REDACTED]"
        }
      }
    ],
    "totalCount": 1,
    "pageInfo": {
      "hasNextPage": false,
      "hasPreviousPage": false,
      "startCursor": "eyJ0aW1lc3RhbXAiOjE3NzM1NjYwNDAwMDAsInN0YWNrSWQiOiJzdGFjay1vcmRlci0xMDEifQ==",
      "endCursor": "eyJ0aW1lc3RhbXAiOjE3NzM1NjYwNDAwMDAsInN0YWNrSWQiOiJzdGFjay1vcmRlci0xMDEifQ=="
    }
  }
  ```

---

### 2. `inspect_workflow` — Deep-Dive into Steps, Context & Errors

Use `inspect_workflow` to inspect a specific `stackId`, view step-by-step execution status and failure diagnostics, or extract a targeted nested context path.

* **Example Natural Language Prompt**:
  > *"Inspect stack-order-101 and tell me which step failed and what payment method was used."*

* **Tool Arguments**:
  ```json
  {
    "stackId": "stack-order-101",
    "contextPath": "payment",
    "includeSteps": true
  }
  ```

* **Tool Output**:
  ```json
  {
    "stackId": "stack-order-101",
    "workflowId": "order-checkout",
    "namespace": "store-tenant-1",
    "status": "FAILED",
    "revision": 2,
    "createdAt": "2026-03-15T09:14:00.000Z",
    "updatedAt": "2026-03-15T09:14:02.000Z",
    "context": {
      "method": "card",
      "last4": "4242",
      "token": "[REDACTED]"
    },
    "error": {
      "name": "CardExpiredException",
      "message": "Customer's credit card was expired",
      "stepName": "chargeStripe",
      "apiKey": "[REDACTED]"
    },
    "steps": [
      {
        "stepId": "validateCart",
        "name": "validateCart",
        "status": "COMPLETED",
        "output": {
          "orderId": "101",
          "subtotal": 199,
          "apiKey": "[REDACTED]",
          "payment": {
            "method": "card",
            "last4": "4242",
            "token": "[REDACTED]"
          }
        }
      },
      {
        "stepId": "chargeStripe",
        "name": "chargeStripe",
        "status": "FAILED",
        "error": {
          "name": "CardExpiredException",
          "message": "Customer's credit card was expired",
          "stepName": "chargeStripe",
          "apiKey": "[REDACTED]"
        }
      }
    ],
    "compensations": []
  }
  ```

---

### 3. `execute_workflow_query` — Text-to-GraphQL Queries

When the AI assistant needs custom field selections, multi-alias queries, or cursor pagination across pages, it can read `siglo://schema/graphql` and invoke `execute_workflow_query`.

* **Tool Arguments**:
  ```json
  {
    "query": "query WaitingWithWaitRecords($limit: Int) { workflows(filter: { status: WAITING }, pagination: { limit: $limit }) { totalCount edges { node { stackId waitRecord { correlationKey eventName expiresAt } } } } }",
    "variables": {
      "limit": 5
    }
  }
  ```

* **Redaction Security Guardrail**:
  If a prompt or LLM attempts to bypass secret scrubbing by querying `context(redact: false)` or `output(redact: false)` (either inline or via GraphQL variables), `execute_workflow_query` rejects the query before execution:
  ```json
  {
    "error": "Unredacted field access (redact: false) is not permitted over MCP"
  }
  ```

---

### 4. `resume_workflow` — Prompt-Driven Durable Resumption

When a durable workflow is suspended at `waitForEvent(...)` (for example, awaiting human approval or manual verification), operators can resume it directly from their AI assistant.

* **Example Natural Language Prompt**:
  > *"Approve order ORD-500 using correlation key `approval-ORD-500` with approver `alice@acme.io`."*

* **Tool Arguments**:
  ```json
  {
    "correlationKey": "approval-ORD-500",
    "payload": {
      "approvedBy": "alice@acme.io",
      "notes": "Verified invoice manually"
    }
  }
  ```

* **Tool Output**:
  ```json
  {
    "resumed": true,
    "correlationKey": "approval-ORD-500",
    "namespace": "store-tenant-1"
  }
  ```

---

## 6. Step 4: Reading MCP Resources (`siglo://`)

MCP clients that support **Resources** can attach live workflow state directly into context using `siglo://` URIs:

| URI | MIME Type | Description |
| :--- | :--- | :--- |
| `siglo://workflows/active` | `application/json` | Live summary list of all currently `RUNNING` and `WAITING` workflows in the tenant namespace (supports `?limit=25`). |
| `siglo://workflows/{stackId}` | `application/json` | Complete redacted snapshot (status, steps, compensations, waitRecord, and context) for a specific `stackId`. |
| `siglo://schema/graphql` | `text/plain` | The full GraphQL Schema Definition Language (SDL) contract used by `execute_workflow_query`. |

---

## 7. Step 5: Using the `diagnose_failure` Prompt Template

`@siglo/query/mcp` registers the `diagnose_failure` MCP prompt template. In clients like Claude Desktop or Cursor, developers can select **`diagnose_failure`** from the slash/prompt menu:

* **With `stackId` (`{ stackId: "stack-order-101" }`)**:
  The server automatically fetches and redacts the execution snapshot for `stack-order-101` and embeds it into a structured prompt instructing the model to report:
  1. **Failing Step & Root Cause**
  2. **Execution Context State**
  3. **Saga & Compensation Status**
  4. **Concrete Remediation Plan**
* **Without `stackId` (`{ workflowId: "order-checkout" }`)**:
  Generates a guided multi-step workflow instructing the model to call `search_workflows` (`status: "FAILED"`) followed by `inspect_workflow`.

---

## 8. Step 6: Mounting MCP SSE onto an Existing HTTP Server or Programmatic Client

### Mounting onto an Existing Node.js `http.Server`

If you already run an HTTP server in your service, pass `httpServer` in the `sse` options to attach `/mcp/sse` and `/mcp/messages` without opening a second port:

```typescript
import { createServer } from 'node:http';
import { createWorkflowMcpServer } from '@siglo/query/mcp';

const httpServer = createServer();

const mcpServer = createWorkflowMcpServer({
    storage,
    namespace: 'store-tenant-1',
    transport: 'sse',
    sse: {
        httpServer,
        ssePath: '/mcp/sse',
        messagePath: '/mcp/messages',
    },
});

await mcpServer.start();
httpServer.listen(3000);
```

### Calling `@siglo/query/mcp` Programmatically from a Custom Agent

You can also connect the official `@modelcontextprotocol/sdk` `Client` in-process (via `InMemoryTransport`) or over SSE (`SSEClientTransport`) in your own TypeScript agent scripts:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const client = new Client(
    { name: 'ops-diagnostics-agent', version: '1.0.0' },
    { capabilities: {} },
);

const transport = new SSEClientTransport(new URL('http://127.0.0.1:4100/sse'));
await client.connect(transport);

// 1. Search failed workflows
const searchResult = await client.callTool({
    name: 'search_workflows',
    arguments: { status: 'FAILED', limit: 5 },
});
console.log('Failed workflows:', searchResult.content);

// 2. Read active workflows resource
const activeResource = await client.readResource({
    uri: 'siglo://workflows/active',
});
console.log('Active workflows:', activeResource.contents[0]);

await client.close();
```
