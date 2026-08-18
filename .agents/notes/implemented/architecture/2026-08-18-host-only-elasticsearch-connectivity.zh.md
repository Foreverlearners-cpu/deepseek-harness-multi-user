# Agent Note: 仅限 Host 的 Elasticsearch 连接

Status: implemented

[English](2026-08-18-host-only-elasticsearch-connectivity.md) | 中文

## 问题

多用户搜索 projection 需要维护良好的 Elasticsearch client，但让每个搜索领域自行构造 client，会重复 bootstrap secret 处理、transport 设置、启动检查和关闭行为。把原始 cluster client 暴露给可信 Host 插件之外的组件，还会产生绕过领域授权与 tenant-scoped query 构造的路径。

连接包需要提供连接能力，但不拥有 index mapping、搜索 API、outbox delivery 或 rebuild policy。[Tenant-scoped 搜索 projection 提案](../../proposed/architecture/2026-08-18-tenant-scoped-elasticsearch-search-projections.md)负责这些未来决策。

## 决策

`@deepseek-ai/dsh-elasticsearch` 是位于 `ctx.elasticsearch` 的仅限 Host 的 Cordis 服务。它拥有一个官方 Elasticsearch JavaScript client，并校验一个显式 node：保留可选 path prefix，同时拒绝 credential、query 和 fragment。Authentication 可以为空，也可以且只能使用一种完整的 basic、API-key 或 bearer 策略；即使未知字段与有效策略并存，服务也会失败。Plaintext HTTP 要求 trusted-local opt-in，HTTPS CA 指纹必须包含 64 个十六进制数字或 32 个以冒号分隔的十六进制 byte。

插件 activation 成功前，服务会在 `pingTimeoutMs` 内执行一次不重试的 `ping()`；该值以 Node 最大 timer delay 为上限。在该启动检查返回 `true` 且所属 Cordis fiber 进入 active 状态前，Consumer operation 会被拒绝。调用 `dispose()` 会在清理过程运行前使所属 fiber 退出 active 状态，因此即使 ping 仍在等待，也会立即停止接纳新 operation。Consumer 通过 `operation(callback)` 执行 active 状态下的工作。借用的 TypeScript client API 保留官方 request method、overload 与 helper，但不能直接访问 lifecycle control、transport internal 和 client metadata。Callback 可以返回已物化的响应值，但不能保留 client；它必须等待依赖 client 的 request，并在其结果结算前完整消费或关闭依赖 client 的 stream 与 async iterator。服务会等待每个已接纳 callback（包括失败项），然后等待 `client.close()`。Consumer 保留 index、document、tenant filter、query 构造、最终一致行为和 projection rebuild 的所有权。Typert、API Proxy、模型工具、container 和 microVM 永远不能取得该服务或其 credential。

Transport retry 与 timeout 值是必需配置，而不是包默认值。该包把 `maxRetries` 与 `requestTimeoutMs` 作为官方 client 默认值传入，可信 callback 可以通过官方逐请求选项覆盖，并启用 client metadata redaction。它不记录连接配置、request、response 或受保护内容。`requestTimeoutMs` 不受 ping limit 限制，因为它由维护良好的 transport 使用，而不是由启动 abort timer 使用。

## 实施经验

Client 包装代码很小，但仓库集成是交付成本的主体。新增仅限 Host 的包要纳入 workspace 解析、Host compiler face、生成的包与 Cordis catalog、依赖分析、第三方声明、包 invariant、双语文档和发布检查。因此，大部分耗时来自证明仓库已正确接纳该包，而不是调用 `new Client()`。

安全与生命周期行为构成另一项必要成本。Authentication mode 必须互斥，plaintext transport 必须要求显式启用，启动连接必须有时间限制且不重试的失败路径，dispose 必须在等待已接纳 callback 时拒绝新工作。基础设施服务统一实现并测试这些规则，可以防止各搜索领域产生细微差异。

维护良好的官方 client 与仅提供连接能力的包，使该层无需拥有 protocol 代码和领域 policy。模块级 client 替身使启动与生命周期竞态可被确定性测试，本地 HTTP fixture 校验实际 transport，opt-in 真实 cluster smoke 校验 deployment compatibility。该分层把快速 logic feedback 与 dependency 和 deployment evidence 分开。

类似基础设施包应先确定所有权与信任限制，再设计 service API；首个包只承担一项自身拥有的职责；增加领域行为前先测试启动与 dispose 竞态；并保留一项可选的真实服务 smoke。Package catalog、compiler face、dependency analysis、notice、invariant companion、双语文档和 publication check 都会消费包 metadata，因此 repository integration 需要纳入计划工作。

## 备选方案

**让每个搜索领域构造 Elasticsearch client。** 否决，因为 credential 处理、transport policy、启动失败和完全停稳的 shutdown 会在各个 Consumer 中产生差异，却没有增加领域价值。

**公开与 provider 无关的通用搜索服务。** 当前里程碑否决，因为没有第二个 provider 或具体搜索 Consumer 能证明稳定的公共 API，而且隐藏 Elasticsearch query model 会降低失败与一致性语义的明确程度。

**通过 remote 或模型控制 API 暴露 client。** 否决，因为持有 cluster client 不等于获得授权。领域服务必须在 Elasticsearch 执行前构造 tenant-scoped operation。

**在该包中实现 mapping、outbox indexing 和 rebuild。** 否决，因为这些行为取决于每项 projection 的权威来源、document schema、retention 和产品 freshness 要求。

## 后果

首个包提供一个显式 cluster target，支持 basic、API-key、bearer 或无认证 bootstrap；默认要求 HTTPS，并严格校验 SHA-256 CA 指纹。无效 security field 与 timer value 会在构造 client 前失败。连接或认证失败会使启动失败，shutdown 会在关闭 transport 前等待 callback 完全停稳。借用 API 可以防止 typed Consumer 直接误控生命周期，但官方 response 与 error metadata 仍可能携带 connection object，可信 callback 也能保留或 cast 运行时对象。Consumer 必须把 transport metadata 当作只读 diagnostic，并遵守文档规定的生命周期。Bootstrap credential 在重新加载插件前保持固定。

该包尚未提供具名 binding、custom CA file、managed-service discovery、classified failure、health telemetry、cancellation policy 或有界 shutdown deadline。搜索领域集成与受支持 version compatibility matrix 属于独立后续工作；unit coverage 针对官方 client API 证明配置、启动、callback admission、failure propagation 和 dispose，opt-in 真实 cluster smoke 则证明通过 Cordis 启动并取得 callback access。
