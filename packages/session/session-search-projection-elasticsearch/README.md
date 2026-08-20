# @deepseek-ai/dsh-session-search-projection-elasticsearch

English | [中文](README.zh.md)

Host-only Cordis function plugin that projects complete session messages into Elasticsearch from the content-free `session.message.changed` Kafka event. It subscribes through an independent consumer group, reads the identified complete message from a required source service, and writes one externally versioned document per event. The [session change projection reference](../../../docs/multi-user/session-change-projections.md) defines the shared delivery flow; the [Consumer Agent Note](../../../.agents/notes/implemented/architecture/2026-08-20-session-search-projection-elasticsearch.md) owns the rationale.

This package is opt-in. It is not part of shipped product bundles.

## Configuration

Every field is required. The plugin supplies no deployment-size default.

| Field | Meaning |
|---|---|
| `topic` | Kafka topic authorized on `ctx.kafka` |
| `groupId` | Independent consumer group authorized on `ctx.kafka`; the reference name is `dsh-session-message-search` |
| `maxBytes` | Complete Kafka-value byte limit passed to `decodeSessionMessageChange` |
| `index` | Elasticsearch index that already exists with the expected mapping |
| `mode` | Kafka start mode: `committed`, `earliest`, or `latest` |

```yaml
- name: '@deepseek-ai/dsh-session-search-projection-elasticsearch'
  config:
    topic: dsh.session.message-changes
    groupId: dsh-session-message-search
    maxBytes: 4096
    index: dsh-session-messages
    mode: committed
```

## Injected services

The plugin injects `kafka`, `elasticsearch`, and `sessionCompleteMessageQuery`. `ctx.sessionQuery` is not this source: it reads session-log windows and does not return an authoritative complete message with owner identity at `(sessionId, sourceSeq)`.

`sessionCompleteMessageQuery.read(sessionId, sourceSeq)` must return one complete user or assistant message:

- `userId` — authoritative private-session owner
- `messageId` — immutable message identity
- `role` — `user` or `assistant`
- `visibleText` — complete visible text only; no reasoning or failed partial output
- `occurredAt` — canonical UTC source time stored on the document

A later MySQL owner provides this service. Tests supply a narrow double with that method. The plugin does not invent CDC.

## Projection

Startup reads the index mapping and compares each required field's `type`. Extra fields are allowed. A missing index, missing field, or type mismatch rejects plugin activation. The plugin never creates an index or updates a mapping.

The Kafka handler decodes the value with `decodeSessionMessageChange`. Invalid UTF-8, JSON, fields, or payload size reject the handler.

For `upsert`, the handler reads the complete message, requires `userId` and `messageId` to match the event, and indexes one live document. For `delete`, it does not query the source; it indexes a tombstone that keeps identity, `source_seq`, `source_time` from `occurredAt`, and `deleted: true`.

Document `_id` is the lowercase hex SHA-256 of `JSON.stringify([userId, messageId])`, so ids stay stable without delimiter collisions. Elasticsearch `version` is `sourceSeq + 1` with `version_type: 'external'`. An equal-or-lower version conflict is a successful no-op. Duplicate events are therefore safe.

| Field | Upsert | Tombstone |
|---|---|---|
| `user` | verified owner | event owner |
| `session` | event session | event session |
| `message` | verified message | event message |
| `role` | `user` or `assistant` | omitted |
| `content` | complete visible text | omitted |
| `source_time` | source `occurredAt` | event `occurredAt` |
| `source_seq` | event `sourceSeq` | event `sourceSeq` |
| `deleted` | `false` | `true` |

Required mapping types: `user`, `session`, `message`, and `role` are `keyword`; `content` is `text`; `source_time` is `date`; `source_seq` is `long`; `deleted` is `boolean`.

`dsh-kafka` commits the record offset only after this handler succeeds. Decode, identity, source-query, and Elasticsearch failures reject the handler, leave the offset uncommitted, and fail-stop the subscription. There is no retry topic, dead-letter queue, or automatic poison skip.

Disposal stops polling, waits for the active handler and its Elasticsearch write, then closes the subscription. Logs may include `eventId`, Kafka partition, offset, and stable failure codes. They omit `userId`, `sessionId`, `messageId`, query bodies, documents, and message content.

The event is valid only for one physically single-tenant deployment. A later search API must add the authenticated `userId` predicate before Elasticsearch executes; this package does not search.

## Model Experience

None, as this Host-only search projection Consumer registers no prompt, tool, message, session event, or model-facing service.

#### KV Cache effect

None; Kafka consumption and Elasticsearch writes are independent of model requests.

## Known Limitations and Deferred Work

- **No search API** — indexing only; callers cannot query documents through this plugin.
- **No index administration** — operators provision the index and mapping; the plugin never creates, aliases, or mutates them.
- **No rebuild or tombstone cleanup** — Elasticsearch remains rebuildable from MySQL and the session log, but this package does not run those jobs.
- **Fail-stop consumption** — a poison record blocks the partition until the plugin remounts; retries and dead-letter handling are out of scope.
- **Required source service** — production MySQL complete-message lookup is a later provider of `sessionCompleteMessageQuery`.
- **Opt-in composition** — the plugin is absent from shipped product bundles until a deployment mounts it explicitly.
