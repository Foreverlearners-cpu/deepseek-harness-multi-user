# Elasticsearch 基础设施

[English](dsh-elasticsearch.md) | 中文

本参考文档说明仓库中已有的 Elasticsearch 基础设施。[`@deepseek-ai/dsh-elasticsearch`](../../packages/multi/elasticsearch/README.md)提供仅限 Host 的连接能力；搜索领域插件仍拥有 authorization、tenant-scoped query、index、document、projection delivery 和 rebuild policy。[Tenant-scoped 搜索 projection 提案](../../.agents/notes/proposed/architecture/2026-08-18-tenant-scoped-elasticsearch-search-projections.md)负责尚未实现的设计。

## 当前服务

`ctx.elasticsearch` 为一个显式配置的 HTTP(S) node 拥有一个官方 Elasticsearch JavaScript client。配置选择 authentication、TLS fingerprint policy、retry default、request timeout 和启动 ping timeout。[包 README](../../packages/multi/elasticsearch/README.md#configuration)是配置与失败语义的参考；[多用户基础设施 subsystem](../subsystems/multi-user-infrastructure.md#elasticsearch-connection)包含生成的 Cordis API。

只有一次不重试的 `ping()` 在 `pingTimeoutMs` 内完成后，插件 activation 才会成功；activation 完成前，Consumer operation 会被拒绝。可信 Host Consumer 通过 `operation(callback)` 使用借用的官方 client API。Dispose 会停止接纳新 callback、等待已接纳 callback 结算，然后关闭 client。Callback 生命周期和 stream 消费要求属于包约定。

## 信任与所有权

Typert、API Proxy、模型工具、container 和 microVM 不会取得该服务或其 bootstrap credential。TypeScript 借用限制可防止直接误控 transport 或生命周期，但它不是面向可信 Host 代码的运行时沙箱。

该服务不执行 request authorization，不选择 index，不注入 tenant predicate，也不校验领域 query field。搜索领域 Consumer 必须从 authenticated authority 派生 tenant identity，并在执行前把 tenant predicate 放入 Elasticsearch request；执行后再过滤返回的 hit，无法阻止 count、score、aggregation、timing 或 resource use 泄露跨 tenant 信息。

Elasticsearch 是可重建的 projection，不是权威状态。MySQL 或所属的持久 event log 仍是 mutation、authorization、replay、reconciliation 和 deletion ordering 的真源。Elasticsearch 不可用时，Consumer 不得回退到无 scope 的 query。

## 计划中的 projection 工作

Named binding、classified transport failure、health 与 telemetry API、tenant query enforcement、outbox delivery、external versioning、tombstone 和 generation-based rebuild 仍处于提案阶段。其所有权、备选方案、验收标准和风险位于 [tenant-scoped 搜索 projection Agent Note](../../.agents/notes/proposed/architecture/2026-08-18-tenant-scoped-elasticsearch-search-projections.md)。
