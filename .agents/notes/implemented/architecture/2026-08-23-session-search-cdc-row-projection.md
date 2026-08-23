# Agent Note: Session search CDC row projection

Status: implemented

English | [中文](2026-08-23-session-search-cdc-row-projection.zh.md)

## Problem

Session search needs a tenant-scoped Elasticsearch document for each complete visible message without coupling the CDC producer to search behavior. Kafka delivery is at least once and can replay older records, so a delayed update or delete must not overwrite newer indexed state.

## Decision

`@deepseek-ai/dsh-session-search-projection-elasticsearch` consumes `CdcEvent` through `ctx.kafkaEvents` and projects the fixed session-message row format. It accepts only its configured topic, database, table, schema fingerprints, and matching Kafka, event, and row-image keys. Insert and update use `after`; delete uses `before`. Explicit unrelated `changedColumns` updates are acknowledged without a write, while a missing hint always processes the row.

The document id hashes tenant, user, and message identity. The authoritative positive integer `revision` is the Elasticsearch external version. A version conflict proves equal or newer state and is acknowledged. Deletes, non-completed rows, and rows not visible to the user write versioned tombstones; only completed user-visible rows include role and visible text.

The plugin validates the existing index mapping before subscribing. Elasticsearch failures and invalid CDC records reject the handler before Kafka commits. Unexpected subscription completion unloads the plugin instead of leaving an active non-consuming component.

## Alternatives considered

**Index the generic CDC row unchanged.** Rejected because it would expose storage field names as the search API, omit tenant-safe document identity, and index partial or private message states.

**Use Kafka partition offsets as Elasticsearch versions.** Rejected because offsets cannot be compared across partitions or after repartitioning.

**Delete Elasticsearch documents physically.** Rejected because retaining a versioned tombstone prevents an older upsert from resurrecting deleted or hidden content.

**Query the database after every event.** Rejected for this row-image implementation because the fixed full CDC row already contains the complete visible projection and an additional read would add availability and latency coupling.

## Verification

Focused tests cover visible indexing, tenant document identity, deletes and hidden-state tombstones, authoritative revisions, wrong routes, fingerprints and keys, changed-column filtering, missing hints, version conflicts, mapping validation, and scoped subscription closure.

## Consequences

Visible message text is present in the internal Kafka CDC topic, so broker ACLs, retention, and operator access must protect it. Search callers still enforce authenticated tenant and user filters. Historical backfill, reconciliation, index creation, aliases, and revision-reset rebuilds remain operator-owned workflows.
