# @deepseek-ai/dsh-session-cache-invalidation-redis

English | [中文](README.zh.md)

Host-only Consumer that validates session-message CDC records through `dsh-cdc-protocol` and `dsh-kafka-events`, then atomically advances a Redis revision watermark and deletes the tenant-isolated complete-session cache.

## Configuration

All fields are required: `topic`, `groupId`, `subscriptionId`, `fallbackMode`, `maxBytes`, `database`, `table`, and `schemaFingerprint`. The Kafka service must authorize the same topic and group. The source route and schema fingerprint must match exactly.

## Event rules

The configured table has exactly `tenant_id`, `user_id`, `session_id`, `message_id`, `revision`, `status`, `visibility`, `role`, `visible_text`, and `occurred_at`. The Kafka key has exactly the four identity fields and must equal the encoded event key and both available row images. Inserts and deletes invalidate. An update skips only when `changedColumns` exists and has no intersection with `status`, `visibility`, `role`, `visible_text`, or `occurred_at`; an absent hint invalidates conservatively.

## Redis consistency

Cache and watermark keys include `tenantId`, `userId`, and `sessionId`. Invalidation uses one Lua operation to compare canonical positive decimal revisions, advance the watermark only for a newer authoritative revision, and delete the cache. Kafka partition offsets never become data versions.

`refillSessionContextCache()` is the required cache-population helper. Its Lua comparison rejects a candidate below the current watermark and writes an accepted value atomically, preventing an old database read from repopulating a cache after invalidation.

`applySessionContextCacheSnapshot()` exposes the same atomic watermark advance and invalidation without Kafka metadata. A reconciler supplies tenant/user/session identity plus an authoritative revision, so live CDC and repair flows cannot diverge in Redis ordering behavior.

Decode, route, identity, schema, Redis, and script failures reject the event handler, so `dsh-kafka-events` cannot permit offset commit. An unexpected subscription failure emits a fixed diagnostic without broker details and disposes the plugin; ordinary disposal closes and drains the owned typed subscription.

## Model Experience

None. The Consumer has no model-facing output, token effect, or KV Cache effect.

## Known Limitations and Deferred Work

- The package fail-stops on invalid records and Redis failures; retry topics and dead-letter administration remain external.
- Snapshot enumeration and full cache rebuilding remain with their source owners; reconcilers apply discovered revisions through `applySessionContextCacheSnapshot()`.
- Schema changes require an explicit configuration update and coordinated deployment.
