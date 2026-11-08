# Follow-up: optional PostgreSQL and Kafka outbox support

Deferred on 2026-11-06 while continuing the Kafka routing tutorial. Revisit this when planning the next adapter feature or documentation tutorial. This file records the follow-up; it is not a scheduled notification.

- Keep basic Kafka consumption independent of outbox infrastructure.
- Put transactional enqueueing, tables, and ownership-safe row claims in `@siglo/postgres`.
- Put the KafkaJS publishing relay, retry behavior, and shutdown handling in `@siglo/kafka`.
- Share the application's transaction client so business changes and outgoing events commit together.
- Document stable event IDs, downstream deduplication, publication ordering, and crash recovery.
- Test concurrent relays and crashes after publication but before marking a row sent.

The [current outbox recipe](https://github.com/jsoftgem/siglo/blob/main/packages/kafka/docs/outbox.md) is the starting point. Built-in support and a dedicated tutorial remain future work.
