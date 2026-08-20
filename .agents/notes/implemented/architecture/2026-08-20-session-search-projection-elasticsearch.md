# Agent Note: Session search projection Elasticsearch Consumer

Status: implemented

English | [中文](2026-08-20-session-search-projection-elasticsearch.zh.md)

## Problem

The content-free `session.message.changed` event tells a search projection which complete message changed, but it carries no body. A Host Consumer must turn that signal into one Elasticsearch document without treating Kafka as a content store, without coupling to MySQL table names, and without allowing an older upsert to resurrect a deleted message.

`ctx.sessionQuery.readEvent` returns a session-log window. It does not identify the private-session owner, and it is not a complete-message lookup at `(sessionId, sourceSeq)`. No MySQL complete-message query service exists yet. Putting mapping mutation, search, rebuild, or Redis invalidation into the same plugin would couple unrelated failure and lifecycle policies.

## Decision

`@deepseek-ai/dsh-session-search-projection-elasticsearch` is a Host-only Cordis function plugin. It injects `kafka`, `elasticsearch`, and `sessionCompleteMessageQuery`, and it is absent from shipped product bundles.

The source contract is one method, `read(sessionId, sourceSeq)`, returning the complete user or assistant visible text plus owner, message id, role, and source time. Tests provide that method as a double. A later MySQL plugin is the production provider. The Consumer does not parse binlog rows or copy Kafka payloads into document content.

`upsert` verifies that the source `userId` and `messageId` match the decoded event, then indexes one live document. `delete` writes a higher-version tombstone that keeps identity, sequence, and `deleted: true` and does not query the source. Document `_id` is the lowercase hex SHA-256 of `JSON.stringify([userId, messageId])`. Elasticsearch external version is `sourceSeq + 1`; an equal-or-lower version conflict is a successful no-op.

Startup compares each required mapping field's `type` and never creates or updates the index. The Kafka handler's success is the only offset-commit signal; decode, identity, source, and Elasticsearch failures fail-stop. Disposal stops polling, waits for the active handler and write, and then closes the subscription. Logs omit owner ids, resource ids, query bodies, documents, and message content.

The shared event and Redis Consumer remain owned by the [user-scoped projection proposal](../../proposed/architecture/2026-08-19-user-scoped-session-change-projections.md). This note does not add `tenantId` or a search API.

## Testing

Package tests cover upsert indexing, delete tombstones, stale-version no-ops, duplicate success, decode/query/Elasticsearch non-commit, mapping refusal, quiescent disposal, and a Loader `cordis.yml` composition that publishes a fixed event through the real plugin entry. They mock Kafka, Elasticsearch, and the source read; they do not claim a live cluster.

## Alternatives considered

**Call `ctx.sessionQuery.readEvent` as the source.** Rejected because that API returns a log window without authoritative `userId` and is not a complete-message read at a session sequence.

**Carry message bodies on the Kafka event.** Rejected in the parent proposal: Redis needs no content, and retained payloads would create another protected-content store.

**Use Elasticsearch `delete` instead of a versioned tombstone.** Rejected because removing the document drops sequence evidence and lets a late lower-version upsert recreate it.

**Create or update mappings at startup.** Rejected because a Consumer must not mutate production index mappings; operators provision them, and a mismatch fails activation.

**Share one projection plugin with Redis invalidation.** Rejected in the parent proposal: cache deletion and search indexing have different dependencies, idempotency, and lifecycle.

**Skip offset commit on version conflict so Kafka retries.** Rejected because an equal-or-lower conflict already means the index holds newer or equal state; retrying would livelock the partition.

## Consequences

Search documents stay rebuildable and ordered by `sourceSeq` without Kafka retaining message text. Production mounting still needs a MySQL `sessionCompleteMessageQuery` provider, a provisioned index, and an explicit composition row. Fail-stop consumption is lossless and visible, and it blocks a partition until remount. Tombstones accumulate until a later cleanup job exists. A later search API must inject the authenticated user predicate before Elasticsearch executes.
