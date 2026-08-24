# Agent Note: MySQL Kafka CDC projections

Status: implemented

English | [中文](2026-08-19-mysql-kafka-cdc-projections.zh.md)

## Problem

Deployments need recent MySQL row changes in Kafka so independent Redis and Elasticsearch projections can update without synchronous database writes. Historical copying and strong consistency are outside this stage, but an outage or uncertain Kafka acknowledgement must not silently advance the MySQL restart position.

The implementation must remain TypeScript and JavaScript across supported platforms. MySQL replication, Kafka publication, and each projection also have different credentials, lifecycle, scaling, and failure domains.

## Decision

`@deepseek-ai/dsh-cdc` owns one dedicated `@vlasky/zongji` replication connection, table routing, the versioned JSON event format, a byte-bounded serial publication queue, and an atomic local checkpoint. It starts at the current binlog tail only when no checkpoint exists and durably records that initial tail before becoming ready. Kafka acknowledgement precedes checkpoint publication, yielding at-least-once delivery and stable duplicate event ids.

MySQL startup requires row-based full images and full metadata, then validates every routed table, ordered primary key, and configured column through `INFORMATION_SCHEMA` before replication starts. Runtime RowsEvents must retain the complete column count and columns-present bitmaps. The producer stops instead of advancing on schema fingerprint changes, corrupt or unavailable positions, statement-based DML, XA, unsupported compressed or partial-JSON events, any recognized schema-changing DDL, routed `TRUNCATE`, missing routes, decoded oversized events, or queue overflow. Sensitive configured columns are removed before serialization and payloads are never logged. Recoverable MySQL failures during startup or runtime and recoverable Kafka publication failures use delay-capped exponential backoff; runtime MySQL recovery resumes from the last publish-safe checkpoint, while semantic and configuration failures remain terminal.

`@deepseek-ai/dsh-cdc-redis` and `@deepseek-ai/dsh-cdc-elasticsearch` are separate consumers of the same wire event. The producer publishes optional `changedColumns` metadata without filtering the durable stream. Each projection may configure `watchedColumns` to skip unrelated updates while inserts and deletes always apply; older version-one records derive changes from full row images. Both require the Kafka key, event key, and available row-image keys to agree. Redis atomically applies the value and a persistent companion version containing topic, partition, and offset; its Lua operation ignores duplicate or older offsets and rejects topic or partition movement. Elasticsearch derives an `external_gte` version from the MySQL binlog file's numeric suffix times 2^32 plus the event position. Before writing or deleting the target document, it writes ordering metadata to `stateIndex`, which defaults to `dsh-cdc-state-v1`. The state id combines the target index, source database and table, and primary key, intentionally excluding the Kafka consumer group; the document records event and source metadata plus the Kafka topic, partition, and offset. A conflict on the initial state write acknowledges a stale event. After a target conflict, the consumer repeats the state write: a conflict there proves that a higher source coordinate superseded the event and is acknowledged, while success propagates the original target conflict for retry. Equal versions remain admissible so the same event can repair a target write after state advanced. Each external effect settles before its Kafka handler, and distinct consumer groups let both projections receive every event.

Kafka subscriptions always resume committed offsets; their fallback applies only to partitions without a commit, and subscription initialization completes before the handle is returned. Both projection plugins supervise unexpected subscription completion, close the failed handle, and resubscribe with exponential backoff; a numeric retry limit unloads the exhausted plugin instead of leaving it apparently healthy. Capture stops on a primary-key value update because old-key and new-key records occupy independently ordered Kafka partitions; supporting that migration requires version-aware projection state or table-level partitioning.

The packages remain separate because capture, cache projection, and search projection have independent deployment authority and failure behavior. The existing Kafka, Redis, and Elasticsearch packages continue to own only their connection transports.

## Alternatives considered

**Direct MySQL-to-Redis and MySQL-to-Elasticsearch writes.** Rejected because either downstream outage would couple capture to a specific projection and prevent other consumers from using the durable Kafka stream.

**One plugin containing capture and both projections.** Rejected because consumers could not scale, deploy, or fail independently and would require all downstream credentials in one process.

**Transactional outbox.** Rejected for this scope because application writes cannot be changed and strong consistency is not required. It remains the appropriate later choice when atomic database-write and event publication becomes mandatory.

**Hand-written replication protocol.** Rejected because `@vlasky/zongji` is an ESM JavaScript dependency with MySQL row, metadata, GTID, and modern authentication support; maintaining equivalent parsing would add substantial protocol risk.

**Kafka tombstones for deletes.** Rejected because a normal versioned delete envelope preserves source metadata and works for both Redis and Elasticsearch consumers. Compact-topic tombstones can be added as an explicit routing policy later.

## Verification

Unit coverage pins JSON validation, change derivation, watched-column filtering, exact scalar normalization, binary and temporal encoding, excluded fields, compound keys, route metadata validation, durable first-start positioning and retry, corrupt checkpoint refusal, atomic checkpoint round trips, complete row-image bitmaps, statement/XA/DDL refusal, retry exhaustion, lifecycle quiescence, Redis offset ordering, and Elasticsearch source-coordinate ordering across Kafka partition and consumer-group changes, including strict conflict branches. The checked-in live smoke exercises MySQL 8 row events, Kafka publication and independent groups, Redis 7 and Elasticsearch 7 projections with an isolated state index, binlog rotation, producer restart, excluded values, and an unwatched update. A direct Elasticsearch 7.16.3 check verifies native `external_gte` behavior for newer, older, and equal versions and for an older write after a versioned delete; the state-index workflow is covered by unit tests rather than that direct server run. Retention gaps, sustained backpressure, schema changes, and full-chain failure injection remain environment-gated work before a production guarantee.

## Consequences

Kafka becomes the fan-out point and Redis and Elasticsearch can consume concurrently without MySQL knowing either destination. Local checkpoints, manual Kafka commits, and projection-side versions keep failure visible and favor ignored duplicates over silent loss or stale overwrite. Redis version hashes remain indefinitely unless a coordinated rebuild resets ordering history. Elasticsearch state documents are correctness metadata and must be retained permanently outside business ILM or rollover. The stable, non-rolling `stateIndex` must differ from every route index, and deployments must also prevent overlap with target aliases or backing indices. `RESET MASTER`, primary changes, or any binlog sequence rollback require a new state index together with clearing or rebuilding the target indices; changing only the state index leaves incompatible external versions on existing target documents. ZongJi reports a RowsEvent size only after packet parsing and row decoding, so `maxBinlogEventBytes` rejects queue admission and publication but cannot bound parser peak memory.

The design does not provide exactly-once effects, cross-table transaction atomicity, history, HA fencing, automatic schema migration, periodic reconciliation, or recovery after binlog retention removes the saved position. Those cases require an explicit rebuild or later synchronization mechanism.
