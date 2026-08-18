# Multi-user infrastructure

English | [中文](multi-user-infrastructure.zh.md)

Host-only connection services under `packages/multi` provide deployment mechanics to trusted multi-user domain plugins. This reference currently owns the shared Redis service semantics and generated Cordis API. The package README owns exact configuration and lifecycle details, while the [infrastructure reference](../infrastructure/dsh-redis.md) owns Redis data rules.

## Responsibility

`ctx.redis` validates a standalone Redis target, verifies connectivity during activation, admits callback-scoped operations, drains admitted callbacks during disposal, and closes the client it creates. It does not authenticate callers, derive tenant scope, name keys, serialize domain records, or decide authorization and outage policy.

Each callback receives the service-owned client only for its invocation. Consumers settle all started work before returning and do not retain, close, or reconfigure the client. Stateful operations that need a dedicated connection use a separately designed service instead of changing shared-client state.

## Authority and isolation

Domain services obtain tenant scope from an authenticated call, enforce resource ownership through authoritative state, and only then construct Redis keys or commands. Redis state remains disposable and rebuildable; it cannot establish identity, membership, grants, ownership, or durable state.

The service remains in the trusted Host composition. It is excluded from the model-facing Cordis runtime catalog and is never exposed through Typert, API Proxy, tools, or model-controlled execution environments.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
