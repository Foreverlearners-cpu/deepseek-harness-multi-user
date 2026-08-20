# @deepseek-ai/dsh-session-message-change-protocol

English | [中文](README.zh.md)

Strict, content-free Kafka wire protocol shared by session cache invalidation and message search projection Consumers. This package is a pure library: it registers no Cordis service, opens no transport, and performs no I/O. The [multi-user reference](../../../docs/multi-user/session-change-projections.md) defines the delivery flow; the [Agent Note](../../../.agents/notes/proposed/architecture/2026-08-19-user-scoped-session-change-projections.md) owns the rationale and alternatives.

## Event

Version 1 carries exactly:

```json
{
  "schemaVersion": 1,
  "eventId": "evt-9001",
  "eventType": "session.message.changed",
  "userId": "user-8",
  "sessionId": "session-100",
  "messageId": "message-12",
  "operation": "upsert",
  "sourceSeq": 12,
  "occurredAt": "2026-08-19T13:49:00.000Z"
}
```

`operation` is `upsert` or `delete`. `sourceSeq` is a non-negative session-local sequence no greater than `SESSION_MESSAGE_CHANGE_MAX_SOURCE_SEQ`, leaving one exact increment for a positive Elasticsearch external version. `occurredAt` is canonical UTC diagnostic time and never determines ordering.

The event carries no message text, reasoning, failed partial output, cache key, index name, credential, or authorization assertion. `userId` is authoritative ownership copied by a trusted Host producer inside a physically single-tenant deployment; it is not caller-supplied authorization.

## API

- `encodeSessionMessageChange(event, { maxBytes })` emits canonical-field-order UTF-8 JSON and rejects an invalid limit or oversized complete payload.
- `decodeSessionMessageChange(value, { maxBytes })` performs strict UTF-8, JSON, exact-field, discriminant, identity, sequence, timestamp, and complete-payload validation.
- `sessionMessageChangeKafkaKey(userId, sessionId)` encodes one unambiguous JSON tuple so equal user/session pairs select equal Kafka keys.
- `SessionMessageChangeEventId()` and `SessionMessageChangeUserId()` brand producer-validated opaque ids. Existing `SessionId` and `MessageId` brands remain owned by `dsh-session` and `dsh-llm`.
- `SessionMessageChangeProtocolError.code` is `invalid-limit`, `payload-too-large`, `invalid-utf8`, `invalid-json`, or `invalid-event`. Error messages never include payloads or protected ids.

Callers must supply `maxBytes`; the protocol has no deployment-size default. Kafka topic, Consumer groups, producer retries, offset commits, cache keys, index mappings, source reads, and projection retries belong to later Consumers or deployment configuration.

## Deployment scope

The event is valid only when one composition, topic, Redis target, and Elasticsearch write target serve one tenant or another physically isolated administrative domain. Shared multi-tenant infrastructure requires an explicit tenant-scoped protocol; `userId` cannot substitute for `tenantId`.

## Model Experience

None, as this pure Host wire library registers no prompt, tool, message, session event, or model-facing service.

#### KV Cache effect

None; encoding and decoding Kafka records are independent of model requests.

## Known Limitations and Deferred Work

- **No producer or Consumer** — fixed test producers and later outbox or binlog publishers remain outside this package, as do Redis and Elasticsearch Consumers.
- **Version 1 only** — unknown versions fail visibly; the pre-release package provides no compatibility alias or migration.
- **Single-tenant transport precondition** — the event cannot safely cross a shared multi-tenant topic, cache, or index without a future explicit tenant scope.
- **Caller-owned byte limit** — every caller must configure and pass the complete-payload limit consistently.
