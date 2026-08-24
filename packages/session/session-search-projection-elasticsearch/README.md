# `@deepseek-ai/dsh-session-search-projection-elasticsearch`

English | [中文](README.zh.md)

Host-only Consumer that validates MySQL CDC row images and maintains a tenant-scoped Elasticsearch message projection. It uses `ctx.kafkaEvents` for decode/commit lifecycle and `ctx.elasticsearch` for versioned writes.

Configuration names one Kafka topic, group, subscription id, missing-offset fallback, payload limit, source database/table, accepted schema fingerprints, and an existing Elasticsearch index. The source row format is fixed: `tenant_id`, `user_id`, `session_id`, `message_id`, positive integer `revision`, `status`, `visibility`, `role`, `visible_text`, and canonical `occurred_at`.

Every record must match its configured topic, database, table, schema fingerprint, Kafka key, CDC key, and row-image key fields. Insert and update read `after`; delete reads `before`. Updates with explicit `changedColumns` skip only when no projection field changed; records without the hint are processed. Boundary or Elasticsearch failures reject the handler, so Kafka does not commit the record.

Only `status=completed` and `visibility=user` rows store role and visible text. Other states and deletes write a versioned tombstone. Document ids hash `[tenantId,userId,messageId]`; authoritative `revision` is the Elasticsearch external version, so duplicates and older records are successful no-ops and cannot resurrect a tombstone.

The configured index must already map tenant, user, session, message, status, visibility, and role as `keyword`; content as `text`; source_time as `date`; revision as `long`; and deleted as `boolean`. The plugin validates mapping before subscribing and never creates indexes or mappings.

## Authoritative record API

`applySessionSearchProjectionRecord(elasticsearch, index, record)` applies one Kafka-independent `SessionSearchProjectionRecord`. It uses the same tenant-safe document id, authoritative external revision, visibility rules, tombstone document, conflict handling, and Elasticsearch error classification as the CDC handler. A reconciler adapter can wrap it directly as a named sink because the record is structurally compatible with the reconciler contract; this package deliberately does not depend on or register the reconciler.

The API validates its authoritative input. An explicit `deleted` record, a record not in `status=completed`, or a record not in `visibility=user` becomes a versioned tombstone without role or content. HTTP 409 external-version conflicts remain successful no-ops.

The Kafka subscription is supervised after startup. If its `done` promise rejects, the plugin logs a content-free error and disposes its own scope; normal scope disposal closes and drains the subscription.

This package does not provide search APIs, index creation, a snapshot source, reconciliation scheduling, or authorization. Callers must filter every search by authenticated tenant and user. The operator must rebuild the index if authoritative revisions reset.

## Model Experience

This Host-only projection adds no model-visible tools, prompts, or session events.
