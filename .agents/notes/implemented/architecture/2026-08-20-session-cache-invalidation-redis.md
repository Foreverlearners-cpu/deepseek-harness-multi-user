# Agent Note: Session cache invalidation through Redis

Status: implemented

English | [中文](2026-08-20-session-cache-invalidation-redis.zh.md)

## Problem

A physically single-tenant Host must drop the complete session-context Redis entry when a trusted producer publishes a content-free `session.message.changed` event. `@deepseek-ai/dsh-kafka` and `@deepseek-ai/dsh-redis` already own transport and client lifecycle. No package subscribed to the authorized topic, derived a collision-free cache key, or deleted that key with fail-stop offset commit.

Colon-joined Redis keys collide when a user or session id contains the separator. Hidden topic, group, byte-limit, or deployment-identity defaults would let two compositions share a Consumer while targeting different brokers or payload sizes. Reading MySQL or refilling Redis from this Consumer would couple invalidation to source layout and make Redis look authoritative.

The [user-scoped projection proposal](../../proposed/architecture/2026-08-19-user-scoped-session-change-projections.md) still owns the shared wire event and the later Elasticsearch Consumer.

## Decision

`@deepseek-ai/dsh-session-cache-invalidation-redis` is a Host-only Cordis function plugin. It injects `kafka` and `redis`, subscribes through `ctx.kafka.subscribe`, decodes each record with `decodeSessionMessageChange`, and deletes one complete session-context key through `ctx.redis.withClient` and `DEL`. Both `upsert` and `delete` remove the same key. A missing key is success. Repeated deletion is idempotent.

The plugin registers no Cordis service. Configuration supplies `topic`, `groupId`, `subscriptionId`, `mode`, `maxBytes`, and `deploymentId` with no hidden business defaults. `dsh-kafka` must already authorize that topic and group.

The cache key is the canonical JSON array `["dsh.session.context", deploymentId, 1, userId, sessionId]`. `dsh.session.context` and format version `1` are fixed protocol constants. JSON string encoding prevents delimiter collision. `sessionContextCacheKey` is the only supported constructor so a later session-read owner can reuse the same key.

`dsh-kafka` commits an offset only after the awaited handler returns. A decode failure or Redis failure throws, so the offset stays uncommitted and that subscription fail-stops. Recovery remounts the plugin. The plugin does not read MySQL, refill Redis, write Elasticsearch, skip poison records, or retry.

Disposal is the Kafka subscription effect owned by this plugin fiber: polling stops, the in-flight handler and its admitted `withClient` callback settle, then the subscription closes.

Logs may include topic, partition, offset, `eventId` after a successful decode, and a stable error category (`SessionMessageChangeProtocolError.code` or `redis`). They omit `userId`, `sessionId`, `messageId`, the Redis key, and the record body.

The package is opt-in. Default product bundles do not mount it.

## Alternatives considered

**Join key segments with `:` or `/`.** Rejected because a user or session id that contains the separator aliases another pair.

**Encode only `(userId, sessionId)`.** Rejected because two deployments sharing one Redis target would delete each other's keys, and a later key-format change would have no version to isolate.

**Delete different keys for `upsert` and `delete`.** Rejected because Redis holds the complete session context, not one message. Both operations invalidate that one entry.

**Skip an invalid record and commit past it.** Rejected because silent loss hides producer or codec defects. Fail-stop keeps the partition blocked and the record available for remount.

**Read MySQL or refill Redis in this Consumer.** Rejected because cache refill belongs to the session read owner, and this event does not prove authorization or make Redis authoritative.

**Hide topic, group, `maxBytes`, or deployment identity behind plugin defaults.** Rejected because those values vary by deployment and must fail at load when omitted.

**Extract a shared Kafka Consumer base class now.** Rejected until the Elasticsearch Consumer demonstrates identical owned lifecycle. Duplicated subscribe-and-handle wiring is cheaper than a speculative base.

**Mount the Consumer in a default product bundle.** Rejected because Host Kafka and Redis credentials are deployment-specific and the first delivery remains opt-in.

## Consequences

A poison record or Redis outage blocks that partition until an operator remounts the plugin. That is visible and lossless, and it is insufficient for unattended production until retry and quarantine have an owner.

A later session-read owner must call `sessionContextCacheKey` with the same `deploymentId`. A key-format change increments the fixed version constant and leaves old keys to expire or be deleted by later events.

Deployments still provision the topic, authorize it on `dsh-kafka`, and keep one physically isolated Redis target. `userId` remains an in-deployment owner, not a tenant scope.

## Testing

Package tests drive a fake `ctx.kafka` and `ctx.redis`: `upsert` and `delete` delete the same derived key, a missing key succeeds, repeated deletion is idempotent, decode and Redis failures throw without an offset commit, disposal removes the subscription after the in-flight `DEL` settles, and logs omit protected identifiers. A Loader composition boots a test-only `cordis.yml` through the real package entry and proves the function plugin has no default export.
