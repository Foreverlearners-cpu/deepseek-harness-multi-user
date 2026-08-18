# 多用户基础设施

[English](multi-user-infrastructure.md) | 中文

`packages/multi` 组包含供多用户领域插件使用的可信、仅限 Host 的连接服务。这些服务拥有 deployment client 构造与生命周期；authorization、tenant-scoped operation、持久数据与 projection data 仍由领域 Consumer 拥有。[Elasticsearch 基础设施参考](../infrastructure/dsh-elasticsearch.md)说明当前所有权，并链接拟议的 projection 设计。

## Elasticsearch 连接

[`@deepseek-ai/dsh-elasticsearch`](../../packages/multi/elasticsearch/README.md) 通过 `ctx.elasticsearch.operation(callback)` 公开一个官方 Elasticsearch JavaScript client。启动过程要求在配置的 timeout 内完成一次不重试的 ping。Dispose 会拒绝新 callback、等待已接纳 callback，并在它们结算后关闭 client。

Callback 收到 vendor client 的借用视图 `ElasticsearchClient`，因为 Elasticsearch query、response 与 failure 仍具有实质性的 provider 特征。该视图保留官方 request overload 与 helper，但不能直接访问 lifecycle control、transport internal 和 client metadata。Callback 可以返回已物化的响应值，但不能保留 client；它必须等待依赖 client 的 request，并在其结果结算前完整消费或关闭依赖 client 的 stream 与 async iterator。官方 response 与 error metadata 仍可能携带 connection object；该类型限制用于防止 typed Consumer 直接误用，而不是对可信 Host code 提供沙箱。

只有可信 Host 插件可以调用该服务。Typert、API Proxy、模型工具、container 和 microVM 都不能取得该服务或其 bootstrap credential。搜索领域 Consumer 必须在 callback 发送 request 前完成请求授权并构造 tenant predicate。

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
<!-- END GENERATED cordis-surface -->
