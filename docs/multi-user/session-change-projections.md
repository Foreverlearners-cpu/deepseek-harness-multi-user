# Session change projections

English | [中文](session-change-projections.zh.md)

This reference defines the user-scoped Kafka event used to invalidate session caches and drive message search projection in a physically single-tenant deployment. The [user-scoped projection Agent Note](../../.agents/notes/proposed/architecture/2026-08-19-user-scoped-session-change-projections.md) owns the rationale and alternatives. The broader [data and runtime isolation](data-and-runtime-isolation.md) rules continue to govern shared multi-tenant deployments.

## Deployment precondition

One composition, Kafka topic, Redis target, and Elasticsearch write target serve one tenant or another physically isolated administrative domain. Several private users may share that deployment, and `userId` identifies the session owner inside it. A shared multi-tenant topic, Redis target, or Elasticsearch index must carry explicit tenant scope instead and cannot use this event unchanged.

Infrastructure clients remain Host-only. Product requests, model-controlled code, Typert, API Proxy, containers, and microVMs do not receive Kafka, Redis, Elasticsearch, or their credentials.

## Event flow

```text
fixed test producer; later an accepted durable change producer
  -> Kafka session message change topic
     -> session cache invalidation Consumer -> Redis DEL
     -> session search projection Consumer -> session query -> Elasticsearch
```

The initial protocol package does not choose outbox or binlog capture and registers no producer. A future producer translates one committed complete-message change into this event and reuses the same `eventId` when publication outcome is uncertain.

## Kafka contract

The logical topic name is `dsh.session.message-changes`. Deployment configuration supplies the actual topic and authorizes it in `dsh-kafka`. The topic is provisioned outside the application. Reference Consumer groups are `dsh-session-context-cache` and `dsh-session-message-search`, so Redis and Elasticsearch observe every event independently.

The Kafka value is strict UTF-8 JSON with exactly these fields:

| Field | Contract |
|---|---|
| `schemaVersion` | Exactly `1` |
| `eventId` | Non-blank opaque identity stable across publication retries |
| `eventType` | Exactly `session.message.changed` |
| `userId` | Non-blank authoritative private-session owner inside the deployment |
| `sessionId` | Non-blank existing branded session identity |
| `messageId` | Non-blank existing branded immutable message identity |
| `operation` | `upsert` or `delete` |
| `sourceSeq` | Integer from `0` through `Number.MAX_SAFE_INTEGER - 1`, monotonic within the session |
| `occurredAt` | Canonical `YYYY-MM-DDTHH:mm:ss.sssZ` UTC timestamp used for diagnostics |

The value contains no message text, reasoning, failed partial output, cache key, index name, credential, or authorization assertion. A caller supplies an explicit complete-payload byte limit to the codec. The Kafka key is a deterministic, unambiguous encoding of `(userId, sessionId)`.

Invalid UTF-8, invalid or non-object JSON, an unexpected field set, unknown version or event type, blank identity, unknown operation, unsafe sequence, invalid UTC timestamp, null value, and over-limit payload all fail without including protected values in the diagnostic.

## Redis invalidation

`upsert` and `delete` both remove the complete session-context cache entry. The key namespace contains a configured deployment identity, a fixed key-format version, and encoded `userId` and `sessionId` segments. A missing key is successful, and repeated deletion is idempotent. `@deepseek-ai/dsh-session-cache-invalidation-redis` is the opt-in Consumer.

The invalidation Consumer does not read MySQL and does not refill Redis. Active sessions continue from their owned in-process state. The session read owner handles a cold cache miss by reading the complete authoritative session and repopulating Redis. This event does not make Redis authoritative or prove authorization.

## Elasticsearch projection

For `upsert`, the projection Consumer reads the event at `(sessionId, sourceSeq)` through `ctx.sessionQuery`, verifies the authoritative user and message identities, extracts only complete user or assistant visible text, and writes one message document. The document stores user, session, message, role, visible content, source time, source sequence, and deletion state.

For `delete`, the Consumer writes a higher-version tombstone containing identity, sequence, and `deleted: true`. Search excludes tombstones. A later search API supplies the authenticated `userId` predicate before Elasticsearch executes; post-query filtering is forbidden.

Elasticsearch remains rebuildable from MySQL and the session log. Index creation, aliases, mappings, generation rebuild, tombstone cleanup, search API, and result presentation are owned outside the wire protocol package.

## Delivery, failure, and lifecycle

Delivery is at least once. `dsh-kafka` processes one subscription sequentially and commits only after the awaited handler succeeds. Redis deletion tolerates duplicates. Elasticsearch writes `sourceSeq + 1` as an external version and treats an equal-or-lower version conflict as a successful no-op.

The first Consumers fail-stop. Invalid events and dependency failures reject the handler, leave the offset uncommitted, and stop that subscription. Recovery remounts the plugin. Retry topics, dead-letter queues, automatic poison-record skipping, health administration, and unattended recovery are deferred.

Disposal stops polling and waits for the active handler and borrowed dependency callbacks to settle before closing the subscription. Logs exclude owner ids, resource ids, cache keys, query bodies, documents, and message content.

## First delivery scope

The first package is `@deepseek-ai/dsh-session-message-change-protocol`, a pure library that owns event types, strict encoding and decoding, brands not owned by existing session or message packages, byte-bound enforcement, and Kafka key derivation. It creates no Cordis service and performs no I/O.

The Redis Consumer is the opt-in Host plugin `@deepseek-ai/dsh-session-cache-invalidation-redis`. The Elasticsearch Consumer, their test producer, cache read-through behavior, producer capture, search API, retries, dead-letter handling, projection rebuild, and default bundle assembly require separate package reviews.
