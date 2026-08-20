# Agent Note: User-scoped session change projections

Status: proposed

English | [中文](2026-08-19-user-scoped-session-change-projections.zh.md)

## Problem

A single-tenant server deployment with several private users needs session cache invalidation and message search projection without coupling Redis and Elasticsearch Consumers to MySQL table names or a particular change-capture mechanism. The Host-only Kafka, Redis, and Elasticsearch packages provide bounded client lifecycles, but no package owns a session-domain wire event that both Consumers can validate.

Raw row-change records expose storage fields that neither Consumer needs, make table layout part of their protocol, and can copy message bodies or protected columns into Kafka. A content-bearing search event avoids a source read but makes Kafka another retained content store. Duplicated parsers in the Redis and Elasticsearch packages would let validation and version handling drift.

The first delivery omits the MySQL-to-Kafka producer. Tests publish fixed events, while a later outbox or binlog producer can adopt the same protocol without changing either Consumer.

## Proposal

Add `@deepseek-ai/dsh-session-message-change-protocol`, a pure wire library under `packages/session/session-message-change-protocol`. It owns a strict, content-free `session.message.changed` event, binary encoding and decoding, and the deterministic Kafka partition key. It registers no Cordis service and performs no I/O.

Two single-purpose Consumers use the protocol:

- `@deepseek-ai/dsh-session-cache-invalidation-redis` subscribes through `ctx.kafka`, derives one deployment/user/session cache key, and deletes it through `ctx.redis`. Both `upsert` and `delete` invalidate the complete cached context. Cache refill remains with the session read owner.
- `@deepseek-ai/dsh-session-search-projection-elasticsearch` is the shipped Host Consumer: it subscribes through an independent group, reads the identified complete message through `sessionCompleteMessageQuery`, and indexes it through `ctx.elasticsearch`. A deletion writes a versioned tombstone rather than discarding ordering evidence. The [Elasticsearch Consumer note](../../implemented/architecture/2026-08-20-session-search-projection-elasticsearch.md) owns that implementation.

The protocol applies only where one deployment composition, Kafka topic, Redis target, and Elasticsearch write target belong to one tenant or another physically isolated administrative domain. `userId` identifies the private session owner inside that deployment. A shared multi-tenant transport or data target still requires explicit `tenantId` scope under the broader [multi-user control and data planes](2026-08-18-multi-user-control-and-data-planes.md) and [tenant-scoped Elasticsearch](2026-08-18-tenant-scoped-elasticsearch-search-projections.md) proposals. This note does not supersede either proposal.

## Wire event

The Kafka value is strict UTF-8 JSON with exactly these fields:

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

`operation` is `upsert` or `delete`. `sourceSeq` is the non-negative, session-local sequence of the authoritative complete-message fact. `occurredAt` is canonical UTC time for diagnostics, never an ordering substitute. The producer creates one opaque `eventId` and reuses it for every retry of the same source change.

The codec rejects a null value, invalid UTF-8, non-object JSON, missing or additional fields, unsupported versions or event types, blank ids, unknown operations, an unsafe sequence, and a non-canonical UTC timestamp. Encoding and decoding apply one caller-supplied complete-payload byte limit with no hidden default. Failures use stable categories and never quote the payload or protected identifiers.

The Kafka key is an unambiguous encoding of `(userId, sessionId)`. It preserves per-session order when the topic partitioning is stable; it does not authorize the event.

## Delivery and projection semantics

The logical topic is `dsh.session.message-changes`. Deployment configuration supplies the actual topic and the two allowed groups; the reference group names are `dsh-session-context-cache` and `dsh-session-message-search`. Topics are provisioned outside the application because `dsh-kafka` disables automatic creation.

Kafka delivery is at least once. The transport commits an offset only after the awaited Consumer handler succeeds. Redis deletion is naturally idempotent. Elasticsearch writes `sourceSeq + 1` as an external version, treats an equal-or-lower version conflict as a successful no-op, and retains deletion tombstones long enough that an older upsert cannot resurrect a deleted document.

The first Consumers fail-stop: malformed records and Redis, source-query, or Elasticsearch failures reject the handler, leave the offset uncommitted, and stop that subscription. Recovery remounts the plugin and redelivers the record. Retry topics, dead-letter queues, automatic poison-record skipping, projection rebuild, and consumer health administration are separate work.

Disposal stops polling and waits for the admitted handler and borrowed Redis or Elasticsearch callback to settle before the subscription closes. Logs may correlate bounded transport positions and `eventId`; they omit `userId`, `sessionId`, `messageId`, cache keys, query bodies, document bodies, and message content.

## Data ownership and security

MySQL and the durable session log remain authoritative. Redis is disposable and rebuildable. Elasticsearch is eventually consistent and rebuildable. Kafka carries identities, operation, sequence, and time only; it carries no prompt, message body, reasoning, failed partial output, Redis key, Elasticsearch index name, credential, or authorization assertion.

The event's `userId` is copied from authoritative session ownership by a trusted Host producer. It is not accepted from a product request as proof of access. Redis key derivation and Elasticsearch document construction use the validated event only inside the physically single-tenant deployment scope. A later search API must add the authenticated user predicate before Elasticsearch executes the query.

## Package boundaries

The protocol package owns event types, brands not already owned by `dsh-session` or `dsh-llm`, safe encoding and decoding, the complete-payload byte bound input, and Kafka key derivation. It owns no topic administration, producer, Consumer, retry loop, cache key namespace, index mapping, query, or rebuild.

The Redis and Elasticsearch packages remain separate so their dependencies, failure policies, lifecycle, tests, and future deployment cadence do not couple. Shared Consumer machinery is extracted only after both concrete implementations demonstrate identical owned behavior; this proposal adds no speculative base class.

## Alternatives considered

**Send raw binlog or table-change envelopes to every Consumer.** Rejected because it exposes storage layout, broadens Kafka payloads, and forces each Consumer to repeat field filtering and table interpretation. The future producer may read binlog, but it translates accepted complete-message changes into this domain event before publishing.

**Carry complete message content in Kafka.** Rejected because Redis needs no content, Elasticsearch can read the authoritative identified event, and retained Kafka payloads would create another protected-content store with separate access and retention obligations.

**Let each Consumer define its own event parser.** Rejected because field strictness, version support, byte limits, identity brands, timestamp rules, and partition keys are one wire obligation shared by both Consumers.

**Use one configurable projection Consumer for Redis and Elasticsearch.** Rejected because cache invalidation and search indexing have different data dependencies, idempotency mechanisms, failure behavior, and lifecycle evolution.

**Include no owner scope because sessions have opaque ids.** Rejected because unguessability is not authorization and user-private session caches and documents need an explicit owner inside the single-tenant deployment.

**Put `tenantId` in this first event.** Deferred rather than rejected. The accepted deployment has one physically isolated tenant and several private users. A shared multi-tenant topic or target must adopt the explicit tenant contract owned by the broader multi-user proposals rather than silently widening this event.

## Acceptance criteria

- The protocol package round-trips `upsert` and `delete` events and deterministically derives the same key for the same user/session pair.
- Boundary tests reject invalid bytes, JSON values, field sets, versions, event types, ids, operations, source sequences, timestamps, and exact or oversized byte-limit cases without exposing protected values in errors.
- Package exports use existing `SessionId` and `MessageId` brands and brand every remaining opaque cross-boundary id.
- Package documentation states zero direct model-token and KV-cache effects, its single-tenant deployment precondition, and the absence of producer or Consumer behavior.
- Later Redis tests prove exact user/session invalidation, duplicate safety, failed-handler non-commit, and quiescent disposal.
- Elasticsearch Consumer tests prove authoritative source reads, user/message identity matching, complete-message-only indexing, source-sequence ordering, tombstones, and failed-handler non-commit. Pre-query user filtering remains with the eventual search Consumer.
- A test-only Loader composition publishes fixed events through the real package entry path; test producers never enter shipped bundles, and projection Consumers remain opt-in until their acceptance paths pass.

## Risks

- A deployment may reuse this user-scoped event on a shared multi-tenant topic or target. Composition documentation and tests must reject that topology rather than treating `userId` as tenant scope.
- The future producer may generate a new `eventId` for a redelivery. Redis remains safe and Elasticsearch ordering still relies on `sourceSeq`, but diagnostics and any future durable deduplication would fragment.
- An incorrect or non-monotonic `sourceSeq` can let stale search state win. The MySQL persistence owner must preserve the session event sequence rather than deriving order from wall-clock time.
- Fail-stop consumption leaves a partition blocked until remount or operator repair. This is visible and lossless, but insufficient for unattended production operation until retry, quarantine, and health ownership are designed.
- Content-free events make Elasticsearch indexing depend on authoritative source availability. This avoids Kafka content retention but may increase source reads and projection lag.
