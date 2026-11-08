# @siglo/http

Enterprise-grade, resilient, W3C-traced HTTP client steps for Siglo workflows.

## Key Features

- **Coordinated Retries & Backoff**: Smart status code classifier (`429`, `502`, `503`, `504`) with `Retry-After` parsing (both integer seconds and RFC 1123 HTTP dates) and full jitter.
- **ASL Network Egress Perimeter**: Automatic validation against Siglo's AsyncLocalStorage (ASL) network security policies (`allowNetwork`) with host verification.
- **W3C Distributed Tracing**: Automatic injection of W3C `traceparent` and `tracestate` headers linked to active OpenTelemetry spans.
- **Standard Schema Validation**: Native validation of request payloads and response bodies with Standard Schema (`zod`, `valibot`, `arktype`, etc.).
- **Sagas & Rollback Compensation**: Declarative `.compensateWithHttp()` automatically registers REST rollbacks in Siglo's CompensationManager.
- **Deterministic Testing**: `@siglo/http/testing` includes `createMockHttpServer` for mocking requests without launching network listeners.

## Installation

```bash
npm install @siglo/http
```

## Basic Usage

```typescript
import { flow } from '@siglo/core';
import { httpStep } from '@siglo/http';

export const getUser = httpStep('getUser', {
    url: 'https://api.example.com/users/123',
    method: 'GET',
});

const workflow = flow(getUser);
const result = await workflow.run({});
```

The package re-exports the official `StandardSchemaV1` and `StandardJSONSchemaV1`
types from `@standard-schema/spec`, including `StandardSchemaV1.InferInput<S>` and
`StandardSchemaV1.InferOutput<S>`. Runtime validation preserves transformed values
(including `undefined`) and supports structured diagnostic path segments. Native
JSON Schema conversion is a separate capability from runtime validation.
