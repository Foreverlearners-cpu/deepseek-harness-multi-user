# @deepseek-ai/dsh-session-cache-invalidation-redis

English | [中文](README.zh.md)

Host-only Kafka Consumer that deletes one complete session-context Redis key for each validated `session.message.changed` event. It injects `ctx.kafka` and `ctx.redis`, decodes records with [`@deepseek-ai/dsh-session-message-change-protocol`](../session-message-change-protocol/README.md), and performs `DEL` only. The [multi-user reference](../../../docs/multi-user/session-change-projections.md) defines the delivery flow; the [Agent Note](../../../.agents/notes/implemented/architecture/2026-08-20-session-cache-invalidation-redis.md) owns the rationale and alternatives.

The plugin is a Cordis function plugin (`name` / `inject` / `Config` / `apply`) with no default export and no Cordis service. It is opt-in and is not part of any default product bundle.

## Configuration

Every field is required. The plugin supplies no hidden topic, group, byte-limit, or deployment-identity default.

| Field | Behavior |
|---|---|
| `topic` | Non-empty topic already authorized on `dsh-kafka` |
| `groupId` | Non-empty consumer group already authorized on `dsh-kafka` |
| `subscriptionId` | Non-empty subscription identity unique within that Kafka service |
| `mode` | `committed`, `earliest`, or `latest` |
| `maxBytes` | Positive complete-payload byte limit forwarded to `decodeSessionMessageChange` |
| `deploymentId` | Non-empty deployment identity embedded in every cache key |

`dsh-kafka` must list the same topic and group in its allowlists. Topics are provisioned outside the application.

## Cache key

`sessionContextCacheKey({ deploymentId, userId, sessionId })` returns the canonical UTF-8 JSON array `["dsh.session.context", deploymentId, 1, userId, sessionId]`. The kind string and format version `1` are fixed. JSON string encoding keeps `userId` and `sessionId` unambiguous when they contain punctuation that would collide under concatenation.

Both `upsert` and `delete` delete this one key. A missing key is successful. Repeated deletion is idempotent.

## Delivery, failure, and disposal

`dsh-kafka` delivers records sequentially and commits an offset only after the awaited handler returns. The handler decodes the value, then runs `DEL` inside `ctx.redis.withClient`. A decode failure or Redis failure throws, so the offset stays uncommitted and that subscription fail-stops. Recovery remounts the plugin.

Disposing the plugin stops polling, waits for the in-flight handler and its admitted Redis callback, then closes the subscription.

Logs may include topic, partition, offset, `eventId` after a successful decode, and the error category `invalid-limit`, `payload-too-large`, `invalid-utf8`, `invalid-json`, `invalid-event`, or `redis`. They omit `userId`, `sessionId`, `messageId`, the Redis key, and the record body.

The Consumer does not read MySQL, refill Redis, write Elasticsearch, or authorize the event. The session read owner handles a cold miss.

## Deployment scope

The Consumer is valid only when one composition, topic, and Redis target serve one tenant or another physically isolated administrative domain. Shared multi-tenant infrastructure requires an explicit tenant-scoped protocol; `userId` cannot substitute for `tenantId`.

## Model Experience

None, as this Host-only invalidation Consumer registers no prompt, tool, message, session event, or model-facing service.

#### KV Cache effect

None; Kafka consumption and Redis deletion are independent of model requests.

## Known Limitations and Deferred Work

- **Fail-stop only** — invalid records and Redis failures block the partition until remount; retry topics, dead-letter queues, and health administration remain outside this package.
- **Delete only** — the plugin never writes or refills Redis; the session read owner owns cache population.
- **Single-tenant key namespace** — the key embeds deployment identity and user identity, not `tenantId`.
- **Opt-in composition** — default product bundles do not mount this plugin.
