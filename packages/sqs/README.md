# @rivulet/sqs Adapter Guide

`@rivulet/sqs` provides an AWS SQS batch consumer adapter for executing `Rivulet` workflows. It is optimized for AWS Lambda event source mappings and standalone long-polling worker processes, implementing AWS partial batch failure protocols (`ReportBatchItemFailures`), message deduplication, and tenant namespace extraction.

---

## 1. Overview & Architecture

When AWS Lambda is triggered by an SQS queue, it passes a batch of records (`SQSEvent`). If one message in the batch fails, returning an uncaught exception causes the entire batch to be retried by AWS, resulting in duplicate processing of previously successful messages.

`@rivulet/sqs` solves this using AWS SQS Partial Batch Responses:

```
                  ┌───────────────────────────────┐
                  │           AWS SQS             │
                  └───────────────┬───────────────┘
                                  │ Batch of N records
                                  ▼
                  ┌───────────────────────────────┐
                  │       AWS Lambda Trigger      │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │    createSqsBatchHandler      │
                  │  • Iterates event.Records     │
                  │  • Checks IdempotencyStore    │
                  │  • Parses JSON Record Body    │
                  │  • Executes Rivulet        │
                  └───────────────┬───────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
            (Success Message)           (Failed Message)
                    │                           │
                    ▼                           ▼
         ┌──────────────────────┐    ┌──────────────────────┐
         │ • Complete Idemp Key │    │ • Fail Idemp Key     │
         │ • Increment Count    │    │ • Append to          │
         │                      │    │   batchItemFailures  │
         └──────────────────────┘    └──────────────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │      Return Batch Result      │
                  │  { batchItemFailures: [...] } │
                  └───────────────────────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │ SQS deletes succeeded records │
                  │ SQS retries only failed items │
                  └───────────────────────────────┘
```

---

## 2. Installation & Requirements

Install `@rivulet/sqs`:

```bash
npm install Rivulet @rivulet/sqs
npm install --save-dev @types/aws-lambda
```

Peer dependency matrix:
- `Rivulet`: `*` (v1.0.0+)
- `@aws-sdk/client-sqs`: `^3.0.0` (optional if running in AWS Lambda runtime)

---

## 3. API Reference

### `createSqsBatchHandler(workflow, options)`

Creates an AWS Lambda-compliant batch processor function:

```typescript
function createSqsBatchHandler<TInput = any, TOutput = any>(
    workflow: Flow<TInput, TOutput>,
    options?: RivuletSqsOptions<TInput, TOutput>
): (event: RivuletSqsEvent) => Promise<SqsBatchResponse>;
```

### TypeScript Interfaces

```typescript
export interface RivuletSqsRecord {
    messageId: string;
    receiptHandle: string;
    body: string;
    attributes?: Record<string, string>;
    messageAttributes?: Record<string, any>;
}

export interface RivuletSqsEvent {
    Records: RivuletSqsRecord[];
}

export interface SqsBatchResponse {
    batchItemFailures: Array<{ itemIdentifier: string }>;
    processedCount: number;
}
```

---

## 4. Configuration Options (`RivuletSqsOptions`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `input` | `(record: RivuletSqsRecord) => Promise<TInput> \| TInput` | `JSON.parse(record.body)` | Custom mapper transforming an SQS record into workflow parameters. |
| `output` | `(result: any, record: RivuletSqsRecord) => Promise<TOutput> \| TOutput` | `result` | Custom post-processor for step result. |
| `idempotencyStore` | `IdempotencyStore` | `undefined` | Distributed store to deduplicate across re-deliveries. |
| `idempotencyTtlMs` | `number` | `86400000` (24h) | Time-to-live for idempotency lock. |
| `timeout` | `number` | `undefined` | SLA execution timeout per record in milliseconds. |
| `namespace` | `string \| ((record: RivuletSqsRecord) => string \| undefined)` | `record.messageAttributes.namespace` | Namespace extractor for multi-tenant isolation. |

---

## 5. AWS Lambda Configuration: `ReportBatchItemFailures`

To enable partial batch responses in AWS Lambda:
1. In the AWS Lambda Console, navigate to your SQS Trigger configuration.
2. Under **Additional settings**, check the option: **Report batch item failures**.
3. In AWS SAM / CloudFormation / Serverless Framework / CDK:
   ```yaml
   FunctionEventSource:
     Type: SQS
     Properties:
       Queue: !GetAtt MyQueue.Arn
       FunctionResponseTypes:
         - ReportBatchItemFailures
   ```

When this is enabled, returning `{ batchItemFailures: [{ itemIdentifier: 'msg-01' }] }` tells AWS SQS to delete all successful messages in the batch from the queue, while leaving only `msg-01` in the queue to be retried or routed to the Dead Letter Queue (DLQ).

---

## 6. Complete AWS Lambda Production Example

```typescript
import { SQSEvent, SQSBatchResponse, Context } from 'aws-lambda';
import { Step, flow } from 'rivulet';
import { createSqsBatchHandler } from '@rivulet/sqs';
import { PostgresIdempotencyStore } from '@rivulet/postgres';
import { Pool } from 'pg';

// 1. Initialize PostgreSQL Connection Pool outside handler
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
});

const idempotencyStore = new PostgresIdempotencyStore({ client: pool });

// 2. Define Notification Workflow
interface NotificationPayload {
    userId: string;
    template: string;
    destination: string;
}

const formatNotification = Step.create('formatNotification', async (param: NotificationPayload) => {
    return { formattedBody: `Hello user ${param.userId}, template ${param.template}` };
}).modern();

const dispatchEmail = Step.create('dispatchEmail', async (param: any) => {
    // Send email via AWS SES or external provider
    return { dispatched: true, messageRef: `ses_${Date.now()}` };
}).modern();

const notificationFlow = flow(formatNotification, dispatchEmail);

// 3. Create SQS Batch Handler
const sqsHandler = createSqsBatchHandler(notificationFlow, {
    idempotencyStore,
    timeout: 10000, // 10-second deadline per message
    namespace: (record) => record.messageAttributes?.tenantId?.stringValue,
});

// 4. Export AWS Lambda Handler
export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
    context.callbackWaitsForEmptyEventLoop = false;

    const response = await sqsHandler(event);
    console.log(`Processed ${response.processedCount} messages. Failures: ${response.batchItemFailures.length}`);

    return {
        batchItemFailures: response.batchItemFailures,
    };
};
```
