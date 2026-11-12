# Siglo Engineering Launch Articles

High-signal technical deep dives and launch posts for Hacker News (`Show HN`), `r/typescript`, `r/node`, and Dev.to:

1. [**Why We Built a Zero-Daemon Saga Orchestrator in Pure TypeScript**](01-zero-daemon-saga-orchestrator.md)
    - _Focus_: Architectural comparison of in-process orchestration + PostgreSQL Optimistic Concurrency Control (`@siglo/postgres`) vs. external cluster engines (Temporal/Inngest).
    - _Channels_: Hacker News (`Show HN`), `r/node`, `r/typescript`, Dev.to.
2. [**How TypeScript Accumulates Step Types Across Pipelines**](02-type-level-context-accumulation.md)
    - _Focus_: Type-level walkthrough of `Step<TInput, TOutput, TName>`, `MergeStepContext<TAcc, TOut>`, `$steps` history inference, and `StandardSchemaV1` integration.
    - _Channels_: `r/typescript`, Dev.to, Hacker News.
3. [**Testing Retries, Timeouts, and Sagas in <5ms with Virtual Clocks (`@siglo/testing`)**](03-deterministic-workflow-testing.md)
    - _Focus_: Deterministic workflow testing with `createWorkflowHarness`, `FakeClock`, `spyStep`, `injectEvent`, and PII-redacted `replayExecution`.
    - _Channels_: `r/node`, `r/typescript`, Dev.to.
4. [**Self-Healing Structured Outputs and Saga-Backed Tool Calls for LLMs with `@siglo/ai`**](04-self-healing-ai-and-saga-tools.md)
    - _Focus_: Bounded schema repair loops (`maxRepairAttempts`), multi-provider failover cascades, Step-as-Tool LIFO Saga compensations (`defineAiTool`), and zero-trust network egress sandboxing.
    - _Channels_: Hacker News, `r/typescript`, `r/LocalLLaMA`, Dev.to.
