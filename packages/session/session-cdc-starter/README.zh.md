# `@deepseek-ai/dsh-session-cdc-starter`

[English](README.md) | 中文

该 Host-only Cordis 组合插件装配完整的实时会话 CDC 链路。它依次挂载 `dsh-kafka-events`、校验 Elasticsearch mapping 并启动 Elasticsearch consumer、启动 Redis cache invalidator，最后按需挂载 projection reconciler。启动过程是串行的，因此后续步骤失败时会卸载之前已启动的所有子插件。

## 配置

`route` 统一指定共享的 `topic`、`database`、`table` 和 `maxBytes`。`redis` 指定自己的 `groupId`、`subscriptionId`、`fallbackMode` 与精确 `schemaFingerprint`。`elasticsearch` 指定另一组 group 和 subscription id、显式 `fallbackMode`、允许的 `schemaFingerprints` 以及已有 `index`。`monitorIntervalMs` 控制运行时订阅监督频率。可选的 `reconciler.maxBatchSize` 启用 operator 触发的修复。

两个 consumer 的 group 和 subscription id 必须分别不同。Redis fingerprint 必须包含在 Elasticsearch 非空且无重复的 allowlist 中。独立 group 是必要条件：共用 group 会让两者分摊记录，而不是让每条记录同时到达两个 consumer。

## 健康与生命周期

`ctx.sessionCdcStarter.health()` 只返回 starter 状态、两个预期 subscription 的 id、生命周期状态和计数，以及启用时的 reconciler 进度；它不包含记录、异常、后端地址或凭据。任何预期 subscription 缺失、停止或失败，都会让 starter 锁存为 `failed` 并卸载自身 scope。正常卸载会先停止监督、排空两个 consumer，最后关闭 typed event service。

## 对账

启用 reconciler 时，starter 自动注册 `session-cache-invalidation-redis` 和 `session-search-projection-elasticsearch` 两个 sink。它们与实时 CDC 复用同一套权威 revision watermark 以及 Elasticsearch external-version/tombstone writer。应用仍负责在 `ctx.sessionProjectionReconciler` 上注册唯一的权威 `SessionProjectionSource`；本 starter 不读取 MySQL，也不调度任务。

## 模型体验

无。该 Host-only 组合不会注册模型可见的工具、prompt、消息或 session event。

## 已知限制与后续工作

- Retry topic、dead letter 与 operator 重启策略仍由部署负责。
- 启动前必须准备并授权现有 Elasticsearch index、Kafka topic 和两个 group。
- Reconciliation 没有跨 sink 事务；页面重放依赖按 revision 幂等的 sink。
