# 多用户基础设施

[English](multi-user-infrastructure.md) | 中文

`packages/multi` 下仅限 Host 的连接服务向可信多用户领域插件提供部署机制。本文目前拥有共享 Redis 服务语义与生成的 Cordis API；包 README 拥有准确配置和生命周期细节，[基础设施参考](../infrastructure/dsh-redis.md)拥有 Redis 数据规则。

## 职责

`ctx.redis` 校验一个独立部署模式的 Redis 目标，在启用期间验证连接，接纳回调范围内的操作，在资源释放期间等待已接纳回调，并关闭自身创建的客户端。它不认证调用方、不派生 tenant scope、不命名 key、不序列化领域记录，也不决定授权与故障策略。

每个回调只在本次调用期间接收服务拥有的客户端。消费方在返回前等待所有已启动工作结算，并且不保留、关闭或重新配置客户端。需要专用连接的有状态操作使用独立设计的服务，而不改变共享客户端状态。

## 权威性与隔离

领域服务从 authenticated call 获取 tenant scope，通过权威状态执行 resource ownership 校验，之后才构造 Redis key 或 command。Redis 状态始终可以丢弃并重建；它不能建立 identity、membership、grant、ownership 或持久状态。

该服务保留在可信 Host 组合中。它不进入模型可见的 Cordis runtime catalog，也永远不通过 Typert、API Proxy、工具或模型控制的执行环境暴露。

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
