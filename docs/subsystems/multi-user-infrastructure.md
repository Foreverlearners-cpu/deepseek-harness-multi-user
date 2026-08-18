# Multi-user Infrastructure

English | [中文](multi-user-infrastructure.zh.md)

The `packages/multi` group contains trusted Host-only connectivity services used by multi-user domain plugins. These services own deployment client construction and lifecycle; authorization, tenant-scoped operations, and durable or projected data remain with their domain Consumers. The [Elasticsearch infrastructure reference](../infrastructure/dsh-elasticsearch.md) maps current ownership and links its proposed projection design.

## Elasticsearch connection

[`@deepseek-ai/dsh-elasticsearch`](../../packages/multi/elasticsearch/README.md) exposes one official Elasticsearch JavaScript client through `ctx.elasticsearch.operation(callback)`. Startup requires one successful, non-retried ping under the configured timeout. Disposal rejects new callbacks, waits for admitted callbacks, and closes the client after they settle.

The callback receives `ElasticsearchClient`, a borrowed view of the vendor client, because Elasticsearch queries, responses, and failures remain materially provider-specific. It preserves official request overloads and helpers while making direct lifecycle controls, transport internals, and client metadata unavailable. The callback may return materialized response values, but it must not retain the client; it must await client-backed requests and fully consume or close client-backed streams and async iterators before its result settles. Official response and error metadata can still carry connection objects; this type restriction prevents direct accidental misuse by typed Consumers rather than sandboxing trusted Host code.

Only trusted Host plugins may call the service. Typert, API Proxy, model tools, containers, and microVMs do not receive it or its bootstrap credentials. Search-domain Consumers must authorize the request and construct its tenant predicate before the callback sends a request.
## Redis responsibility

`ctx.redis` validates a standalone Redis target, verifies connectivity during activation, admits callback-scoped operations, drains admitted callbacks during disposal, and closes the client it creates. It does not authenticate callers, derive tenant scope, name keys, serialize domain records, or decide authorization and outage policy.

Each callback receives the service-owned client only for its invocation. Consumers settle all started work before returning and do not retain, close, or reconfigure the client. Stateful operations that need a dedicated connection use a separately designed service instead of changing shared-client state.

## Authority and isolation

Domain services obtain tenant scope from an authenticated call, enforce resource ownership through authoritative state, and only then construct Redis keys or commands. Redis state remains disposable and rebuildable; it cannot establish identity, membership, grants, ownership, or durable state.

The service remains in the trusted Host composition. It is excluded from the model-facing Cordis runtime catalog and is never exposed through Typert, API Proxy, tools, or model-controlled execution environments. The [Redis infrastructure reference](../infrastructure/dsh-redis.md) owns its data rules.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxelasticsearch--elasticsearchservice"></a>

### `ctx.elasticsearch` — `ElasticsearchService`

Elasticsearch client service exposed as `ctx.elasticsearch`. Startup pings the configured node; failure rejects plugin activation. Operations are admitted only while the service is active and share one official client.

```ts cordis-catalog
/**
 * Run one callback with the shared official client. Admission precedes the
 * callback, so disposal waits for every callback already accepted.
 * The borrowed API makes direct lifecycle controls, transport internals, and
 * client metadata unavailable. The callback must not retain it after
 * settlement. It must await client-backed requests and fully consume or close
 * client-backed streams and iterators before its result settles. Materialized
 * response values may be returned.
 * @param callback - Elasticsearch work using the callback-scoped client.
 * @returns the callback result.
 * @throws before activation, while the service is closing, or when the callback rejects.
 */
async operation<T>(callback: (client: ElasticsearchClient) => T | Promise<T>): Promise<T>
```

Source: [`packages/multi/elasticsearch/src/index.ts:150`](../../packages/multi/elasticsearch/src/index.ts)

<a id="ctxredis--redis"></a>

### `ctx.redis` — `Redis`

Redis client service exposed as `ctx.redis`. Startup connects and sends `PING`; failure rejects plugin activation. withClient shares the owned non-blocking command client only for the callback lifetime.

```ts cordis-catalog
/**
 * Run one callback with the shared non-blocking command client. Admission
 * precedes callback invocation, so disposal waits for accepted operations.
 * The callback must settle its commands and must not retain or close the client.
 * @param callback - Redis work scoped to this callback.
 * @returns the callback result.
 * @throws when the service is unavailable or closing, or when the callback rejects.
 */
async withClient<T>(callback: (client: RedisClientType) => T | Promise<T>): Promise<T>
```

Source: [`packages/multi/redis/src/index.ts:61`](../../packages/multi/redis/src/index.ts)
<!-- END GENERATED cordis-surface -->
