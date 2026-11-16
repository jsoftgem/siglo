# Siglo Agent Skills Directory

This directory contains specialized Agent Skills for the **Siglo Workflow Framework**, following the open Agent Skills standard.

---

## Available Skills

| Skill                            | Description                                                                                                                                             | Location                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **`siglo-workflow-development`** | Authoring steps, sequential flows, sagas, retries with backoff & jitter, branching, and batch mapping.                                                  | [`siglo-workflow-development/`](./siglo-workflow-development/SKILL.md) |
| **`siglo-durable-workflows`**    | Long-running workflows, asynchronous event suspensions (`waitForEvent`), timer sleeps (`wait`), webhook resumptions, and persistence (Postgres, Redis). | [`siglo-durable-workflows/`](./siglo-durable-workflows/SKILL.md)       |
| **`siglo-ecosystem-adapters`**   | Web frameworks (Express, Fastify, Hono), message queues (BullMQ, Kafka, AWS SQS), AI models (`@siglo/ai`), HTTP steps, and OpenTelemetry.               | [`siglo-ecosystem-adapters/`](./siglo-ecosystem-adapters/SKILL.md)     |
| **`siglo-testing-and-replay`**   | Zero-flake unit and integration testing with `@siglo/testing`, test harnesses, mocks, spies, virtual clocks (`FakeClock`), and failure replay.          | [`siglo-testing-and-replay/`](./siglo-testing-and-replay/SKILL.md)     |

---

## How to Use These Skills in Your Application

1. **For AI Assistants (Automatic)**:
   Any AI coding agent (Antigravity, JetBrains AI Assistant, Claude Code, Cursor, Copilot) automatically discovers these skills. Simply ask the agent to create or refactor Siglo workflows.
   See the complete [Agent Skills Guide](../docs/agent-skills.md) for ready-to-use prompt recipes.

2. **For Human Developers (Manual)**:
    - Each skill contains an `examples/` directory with production-ready, typechecked TypeScript examples you can copy directly into your project.
    - Each skill contains a `references/` directory with API cheatsheets and configuration matrices.
