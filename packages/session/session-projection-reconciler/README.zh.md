# @deepseek-ai/dsh-session-projection-reconciler

[English](README.md) | 中文

通过运维操作触发，使用应用的权威快照重建会话投影。本包不消费 Kafka，也不从 CDC 事件推断权威状态。

## 组合

加载服务时必须显式配置 `maxBatchSize`。应用在数据源插件的 `ctx.effect()` 中调用 `ctx.sessionProjectionReconciler.registerSource(source)`，注入自己的权威 `SessionProjectionSource`。Redis、Elasticsearch 或其他适配器以相同方式注册命名的 `SessionProjectionSink`。注册 disposer 只移除对应的 source 或 sink。

任务启动前必须有且只有一个 source，并至少有一个 sink。本包不包含 MySQL provider；数据表归属、快照一致性、授权和数据库读取均由应用负责。Redis 和 Elasticsearch 包可以独立提供 sink 适配器。

## 记录与分页

`SessionProjectionRecord` 固定包含 `tenantId`、`userId`、`sessionId`、`messageId`、`revision`、`status`、`visibility`、`role`、`visibleText`、`occurredAt` 和 `deleted` 字段。source page 返回有序记录和可选的不透明 `nextCursor`；省略 cursor 表示完成。

`reconcile()` 要求 `batchSize` 为正整数且不超过 `maxBatchSize`，并显式指定 `sinkStrategy: 'sequential'`。source 可以返回终止空页。非终止空页、记录数超过 `batchSize`、cursor 不前进或记录不属于指定 tenant 时，任务在 cursor 推进前以 `invalid-page` 停止。

## Sink 执行与恢复

串行策略以记录为主，并遵循 sink 注册顺序：一条记录写入全部 sink 后才处理下一条记录。source 或 sink 首次失败后立即停止，不执行后续工作。

页起点是持久恢复点。只有一页内的全部记录都成功写入全部 sink，服务才推进恢复点。失败或取消会返回当前页起点 cursor、已处理记录数、已完成页数，并在适用时返回失败 sink 名称。后续重放这一页可能重复此前成功的写入，因此每个 sink 都必须按记录标识和 revision 实现幂等。本服务不提供跨 sink 事务。

一个服务实例同一时间只运行一个 reconcile 任务；第二次调用立即失败。调用方取消与服务销毁共用同一个任务 signal；销毁会取消活跃工作并等待任务结束。

## 健康状态与隐私

`health()` 返回分离的 idle 或 running 快照。运行状态只包含页 cursor、完成计数、可选 tenant id 和当前 sink 名称。健康状态和可恢复失败结果绝不包含记录、`visibleText` 或适配器异常详情。

## 模型体验

### 投影校准重建

#### 模型看到什么

没有内容。`ctx.sessionProjectionReconciler` 仅在 Host 中使用，不注册工具、提示词、消息或会话事件。

#### Token 影响

每次请求直接增加零 Token。

#### KV Cache 影响

与模型请求无关。

## 已知限制与延期工作

- **没有 MySQL source provider** — 应用注入权威 source，并负责快照一致性。
- **不消费 Kafka，也不自动调度** — 每个任务由运维人员或应用显式启动。
- **没有跨 sink 事务** — 页重放依赖 sink 幂等。
- **只有一种执行策略** — sink 按注册顺序串行运行。
- **没有内置 Redis 或 Elasticsearch 适配器** — 对应包可以独立提供 sink 适配器。
