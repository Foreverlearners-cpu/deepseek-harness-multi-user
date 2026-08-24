# `@deepseek-ai/dsh-session-cdc-starter`

English | [中文](README.zh.md)

Host-only Cordis composition for the complete live session CDC path. It mounts `dsh-kafka-events`, validates the Elasticsearch mapping and starts the Elasticsearch consumer, starts the Redis cache invalidator, then optionally mounts the projection reconciler. Startup is sequential so a later failure disposes every earlier child.

## Configuration

`route` owns the one shared `topic`, `database`, `table`, and `maxBytes`. `redis` owns its `groupId`, `subscriptionId`, `fallbackMode`, and exact `schemaFingerprint`. `elasticsearch` owns a different group and subscription id, its explicit `fallbackMode`, accepted `schemaFingerprints`, and existing `index`. `monitorIntervalMs` controls runtime subscription supervision. Optional `reconciler.maxBatchSize` enables operator-triggered repair.

The two consumer groups and subscription ids must differ. Redis's fingerprint must occur in Elasticsearch's non-empty, duplicate-free allowlist. Separate groups are mandatory: using one group would distribute records between consumers instead of delivering every record to both.

## Health and lifecycle

`ctx.sessionCdcStarter.health()` returns only the starter state and each expected subscription's id, lifecycle state, and counters, plus reconciler progress when enabled. It contains no records, errors, backend addresses, or credentials. Missing, stopped, or failed expected subscriptions lock the starter into `failed` and unload its scope. Disposal stops monitoring, drains both consumers, and then closes the typed event service.

## Reconciliation

When enabled, the starter registers `session-cache-invalidation-redis` and `session-search-projection-elasticsearch` sinks. They reuse the same authoritative revision watermark and Elasticsearch external-version/tombstone writers as live CDC. The application still owns and registers exactly one authoritative `SessionProjectionSource` on `ctx.sessionProjectionReconciler`; this starter neither reads MySQL nor schedules jobs.

## Model Experience

None. This Host-only composition registers no model-facing tools, prompts, messages, or session events.

## Known Limitations and Deferred Work

- Retry topics, dead-letter handling, and operator restart policy remain deployment concerns.
- The existing Elasticsearch index and Kafka topic/groups must be provisioned and authorized before startup.
- Reconciliation has no cross-sink transaction; page replay relies on revision-idempotent sinks.
