# Agent Note: Tenant-scoped Elasticsearch 搜索 projection

Status: proposed

[English](2026-08-18-tenant-scoped-elasticsearch-search-projections.md) | 中文

## 问题

多用户搜索与分析 projection 需要 Elasticsearch，但不能让它成为 identity、authorization 或持久产品状态的权威来源。现有仅限 Host 的连接服务拥有一个 client 及其生命周期，但没有定义多个 Consumer 领域如何选择 credential、构造 tenant-scoped request、交付源数据变更或重建 projection。

不受限制的 cluster client 无法执行领域 authorization。遗漏 tenant predicate 的 query 即使由调用方过滤返回的 hit，也可能泄露 document existence、count、score、aggregation、timing 和 resource use。Projection delivery 还必须容忍重复与乱序工作，不能用较旧源状态覆盖较新状态，也不能让已删除记录恢复。

## 提案

仅在具体搜索领域 Consumer 需要共享连接行为时演进 [`@deepseek-ai/dsh-elasticsearch`](../../../../packages/multi/elasticsearch/README.md)。基础设施服务拥有 client 构造、named connection lifecycle、endpoint security、transport policy、classified transport failure、health 和有界的 client-level observability。每个领域 Consumer 拥有 index name、mapping、document schema、authorization、query 构造、retention、outbox consumption 和 rebuild orchestration。

Elasticsearch 始终是最终一致且可重建的 projection。MySQL 是 relational mutation 与 outbox record 的真源；所属的持久 event log 仍是 event-sourced data 与模型 replay 的真源。Authorization、membership、revocation、durable mutation acknowledgement 和 audit authority 绝不依赖 Elasticsearch 内容或可用性。

该服务仍仅供可信 Host 插件使用。Typert、API Proxy、tool、model execution、container 和 microVM 不会取得 cluster client 或 bootstrap credential。

## 服务模型

该服务提供显式命名的 Elasticsearch binding。每个 binding 拥有一个官方 Elasticsearch client 与一个 cluster target，使 control-plane、indexing 和 search composition 可以使用不同 credential 或 deployment，而无需改变领域代码。Binding id 在包边界使用品牌类型 `ElasticsearchBindingId`。

```text
ctx.elasticsearch
  binding(bindingId: ElasticsearchBindingId) -> ElasticsearchBinding

ElasticsearchBinding
  operation(options, callback)
  health(signal)
```

`operation` 仅在 binding 运行期间接纳工作，并在该 callback 生命周期内向其传入借用的官方 client API。该 API 保留官方 request overload，但排除直接 client lifecycle control、transport property 和 client metadata。调用方可以返回已物化的响应值，但不能保留 client；它必须等待依赖 client 的 request，并在 callback 结果结算前完整消费或关闭依赖 client 的 stream 与 async iterator。官方 response 与 error metadata 仍可能携带 connection object，调用方必须将其视为只读 diagnostic。

每个 Consumer 通过 Cordis 插件配置选择经过校验的 binding。缺少 binding 或存在重复 binding 会使插件 activation 失败。包边界上的 binding 选择始终显式；不存在把 Consumer 静默重定向到另一个 cluster 的 process-global default。

Binding 在 dispose 期间停止接纳新工作，在配置的 shutdown bound 内等待 active callback，记录超限 operation 时不包含 request body 或受保护内容，并在 dispose 完成前关闭 client。

## 配置与 bootstrap

随 deployment 变化的值使用经过校验的 Cordis 插件配置。

| 配置区域 | 必需行为 |
|---|---|
| Endpoint | 解析一个明确的 node 或维护良好的 discovery configuration；允许显式 proxy path，并拒绝 credential、query、fragment、不完整 URL 和不支持的 protocol |
| Bootstrap identity | 接受显式选择且维护良好的 client authentication method，拒绝未知或冲突字段，并使 credential 不进入 MySQL 与 Elasticsearch document |
| TLS | 在 server profile 中校验 server identity；接受完整 trust input，而 plaintext 或 disabled verification 仅限显式 trusted-local profile |
| Transport | 配置 request-timeout 与 retry default、connection timeout、retry-on-timeout behavior 和 shutdown bound；定义 Consumer 可逐请求覆盖的值 |
| Compatibility | 在启动期间校验受支持的 Elasticsearch product 与 version range |
| Observability | 配置有界 operation name 与 telemetry hook，且不启用 request-body logging |

Elasticsearch credential 是由 orchestrator 或维护良好的 secret service 提供的 bootstrap secret。Diagnostic 与 resolved configuration 绝不暴露 password、API key、bearer token、client private key、signed request header 或包含 credential 的 URL。

Production credential 仅获得其 Consumer composition 所需的 cluster 与 index privilege。Index-template administration、rebuild job、runtime indexing 和 runtime search 可以使用不同 binding 与 credential。Trusted-local profile 只有在配置显式接受较弱 operational isolation 时才能合并角色。

## Operation 与失败语义

- Binding 使用维护良好的官方 Elasticsearch JavaScript client，不会把其 query DSL 或 response field 包装为通用 search abstraction。
- 在 client 支持 abort signal 时，cancel 会到达 client request。如果 cancel 与 indexing request 竞争，Consumer 会把 write outcome 视为未知，直到 source-revision reconciliation 证明 indexed state。
- 服务对 authentication、authorization、product 或 version mismatch、timeout、cancellation、unavailable-node、rejected-execution、malformed-response 和 transport failure 分类，且不包含 request body 或受保护的 document content。
- 服务不会重试任意 Consumer callback。配置的 client transport 仅按有文档说明的 client rule 重试 request；Consumer 必须先使 projection write 幂等，再允许 retry。
- 成功的 indexing response 不会使 Elasticsearch 成为权威来源。Source record 与已提交 outbox entry 仍是 reconciliation 与 rebuild 的依据。
- Search failure 绝不回退到无 scope 的 query 或来自其他 tenant 的 stale result。Consumer 根据产品行为返回显式 unavailable 或 stale status。

Metric 与 log 使用的 operation name 是由 Consumer 声明的有界 identifier。Log 与 metric 排除 query body、document body、hit content、authentication material、无界 resource id 和 tenant 提供的 index fragment。

## Index 与 document 所有权

基础设施服务不拥有任何产品 index、alias、template、mapping、ingest pipeline、lifecycle policy 或 document schema。每个搜索领域 Consumer 拥有唯一 namespace，并定义从其权威来源到 Elasticsearch document 的完整 projection。

Index name 与 alias 来自经过校验的 deployment 和领域配置，绝不直接来自 request field。Consumer 把 alias 视为 operational routing convenience，而不是 authorization control。除非所属领域通过显式 allowlist 校验，否则 request 不能选择任意 index、alias、script、stored query、field name、sort expression 或 aggregation path。

Shard count、replica、rollover、retention，以及 shared-index 与 index-per-tenant topology 的选择仍由首个经过测量的搜索领域决定，而不是成为包默认值。

## Tenant 隔离

每个 tenant-owned document 都携带从 authenticated authority 与权威 source ownership 派生的不可变 `tenant_id`。Request payload 不能建立或覆盖该值。

搜索领域 Consumer 在调用 Elasticsearch 前构造 tenant-scoped request。发送给 Elasticsearch 的 request 必须包含 tenant predicate；禁止在 query 完成后再过滤。

Shared index 要求每条 search、count、update-by-query、delete-by-query、aggregation 和 document-lookup 路径都包含强制 exact-match tenant filter。Index-per-tenant deployment 可降低遗漏 filter 的影响，但会增加 shard、template、rollover 和 rebuild cost；它们仍需要可信 tenant-to-index routing。

Control-plane 与 tenant-runtime process 使用不同的 least-privilege Elasticsearch identity。Client library、network route、credential 和 `ctx.elasticsearch` service 始终位于每个 model-controlled execution environment 之外。

## Projection 一致性

领域 mutation 在一个 MySQL transaction 中提交其权威变更与一条 outbox record。Dispatcher 至少投递一次 outbox record。

Projection Consumer 使用稳定 source identity 加 monotonic source revision，或等价 external versioning，使重复与乱序 delivery 不能用较旧 indexed state 覆盖较新状态。

Deletion 生成携带 source identity 与 revision 的持久 tombstone。Consumer 保留足够的 ordering information，防止较旧 create 或 update 恢复已删除 document。

Rebuild 读取权威状态、写入新的 projection generation、校验 scoped count 与 revision，并且只在 reconciliation 后切换 serving routing。Stale result 会影响产品行为时，搜索领域 API 会公开或考虑 projection lag。

## 生命周期与 observability

- 启动过程校验配置、构造每个 client、验证 Elasticsearch product 与受支持 version，并在发布 binding 前执行轻量 connectivity check。
- Dispose 开始后，runtime admission 会拒绝新 operation。Dispose 会在配置的 bound 内等待，并在本地 transport ownership 结束前关闭每个 client。
- Metric 包含 active operation、operation latency、retry count、node availability、classified failure、startup state、shutdown overrun、oldest pending outbox age 和 rebuild progress。Label 使用 binding 与有界 operation name，而不是 tenant 或 resource id。
- Log 在安全时关联 request id、binding、operation name 和 source revision。它们省略 query DSL、document content、result hit、credential 和 signed header。

Cluster capacity、snapshot、restore、cross-region replication、index retention 和 disaster-recovery objective 属于 deployment operation。恢复权威数据会使受影响 projection 失效，并在这些搜索领域报告 readiness 前触发 reconciliation 或 rebuild。

## 备选方案

**把搜索领域行为放入连接包。** 否决，因为 mapping、tenant predicate、document schema 与 freshness behavior 取决于各领域的 authority，通用 cluster client 无法正确执行这些规则。

**把 Elasticsearch 视为权威应用数据库。** 否决，因为 refresh timing、projection rebuild 与面向搜索的 schema 不提供 MySQL 和持久 event log 所拥有的 transaction、replay 或 authorization guarantee。

**在 Elasticsearch 执行 query 后过滤未授权 hit。** 否决，因为 query 此时已经暴露跨 tenant 的 existence、count、score、aggregation、timing 和 resource use。

**把 shared index 或 index-per-tenant 选为基础设施默认值。** 暂缓决定，因为没有经过测量的 tenant count、document volume、query pattern、shard limit 与 isolation requirement 时，任一选择都可能错误。

## 验收标准

- 共享基础设施 contract suite 针对受支持 Elasticsearch server 运行，并覆盖 authenticated startup、compatibility rejection、timeout、cancellation、classified failure、admission 和 awaited disposal。
- 配置测试拒绝 malformed endpoint、credential conflict、不安全 server TLS setting、无效 retry 或 timeout limit、缺失 binding 和重复 binding，且不暴露 secret value。
- Tenant-domain integration test 使用两个 tenant 的有效 resource，并证明 search、count、aggregation、lookup、update 和 deletion 在 Elasticsearch 执行前发送 tenant predicate。
- Outbox test 重复和重排 delivery、在 MySQL commit 后中断 dispatch，并证明包含 deletion tombstone 的状态按 source revision 收敛。
- Rebuild test 从权威状态创建新的 projection generation，按 tenant reconcile count 与 revision，并证明失败或不完整 generation 绝不成为 serving index。
- Assembled Host test 证明 remote、model、container 和 microVM 路径无法获得 Elasticsearch service、cluster credential 或无限制 index access。
- Operational test 校验有界 label，并确认 log、metric、resolved configuration 和 classified error 省略 credential、request body、document content 与 result hit。

## 风险

- **Tenant enforcement 仍由领域拥有。** 绕过其 query builder 的 Consumer 可以发出无 scope 的 request；least-privilege credential、窄 API 与双 tenant integration test 可以降低但无法消除该可信代码风险。
- **At-least-once delivery 依赖正确 versioning。** 缺少 source revision 或 revision 不单调时，重复、乱序或延迟工作可能破坏 projection。
- **Shutdown bound 可能留下未知 remote outcome。** 超过 bound 后关闭 transport 无法证明 in-flight indexing request 是否已提交；reconciliation 必须解析该状态。
- **Topology 选择可能产生 operational limit。** Shared index 会集中 isolation risk，而 index-per-tenant layout 可能耗尽 shard 与 control-plane capacity；首个领域必须在选择默认值前测量两者。
