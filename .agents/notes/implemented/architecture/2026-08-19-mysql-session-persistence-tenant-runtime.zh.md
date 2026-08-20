# Agent Note: MySQL 会话持久化作为租户/用户运行时插件

Status: implemented

[English](2026-08-19-mysql-session-persistence-tenant-runtime.md) | 中文

## 问题

多用户宿主需要一个持久化会话后端，并且多个租户可以共享一个 MySQL 服务，同时不能让一个租户运行时的 session id 解析到另一个运行时的会话。现有的 `SessionPersistence` seam 负责事件日志语义，MySQL 连接服务负责连接池和事务生命周期。MySQL 后端必须同时保留这两层所有权规则，而不能把多用户分支放进 session loop。

## 决策

`@deepseek-ai/dsh-session-persistence-mysql` 是独立的 Host 插件，实现 `SessionPersistence`，并注入 `ctx.sessions`、`ctx.users` 与 `ctx.mysql`。一个配置好的提供方实例代表一个可信租户/用户运行时 scope。`tenantId` 和 `ownerUserId` 都来自经过校验的插件配置，绝不读取请求字段；所有 session 和 record 查询都带有 owner scope。复合主键 `(tenant_id, session_id)` 仍是物理身份，同时 `(tenant_id, owner_id)` 外键关联 `dsh_users`。

提供方把缓冲、write-behind、checkpoint 屏障、准备结果复用、崩溃恢复和销毁排空交给 `PersistenceCoordinator`。其存储原语在一次 `ctx.mysql.transaction()` 中写入连续批次：锁定 session 行，校验下一条序号，插入不可变记录，推进 `next_seq` 和 `revision`，并将惰性物化与首批事件一起提交。任何失败都会回滚完整批次。

规范逻辑日志仍然是现有的 `SessionEvent` 流。连续的 `assistant/chunk` 段使用 `packChunkRuns` 编码、gzip 压缩并计算校验和，作为一条物理记录存储。读取时用 `decodeStorageRecord` 展开，并校验序号范围和事件数量。这是物理打包，不是删除事件或只保留 message 的投影；assistant message、工具调用/结果、用户消息和轮次边界都能用原始序号重建。

schema 由插件拥有，并使用单调版本记录标记。v2 包含状态标记、用户归属的 session 元数据和租户范围的不可变记录。创建 session 时写入 `owner_kind='user'` 与可信 `ownerUserId`，通过复合外键指向 `dsh_users`。如果 v1 表存在无 owner 行，启动时会拒绝升级，而不会静默把它分给某个用户。schema 在插件 service 初始化期间建立，并拒绝不支持的版本。

`@deepseek-ai/dsh-mysql` 暴露回调范围内的连接和事务辅助方法。连接池生命周期和事务生命周期方法对消费者隐藏；租约在回调结束后失效，连接复用前会 reset，服务销毁前会排空已接纳的调用。这样持久化插件无需管理驱动生命周期，也不能把连接泄漏到回调之外。

## 曾考虑的替代方案

**把租户分支放进 session loop。** 否决：loop 只应使用现有 session 能力。租户授权属于可信运行时组合和后端存储范围。

**使用全局 session id 主键。** 否决：在多用户设计中，id 只保证在租户范围内唯一。复合键让跨租户误读在存储边界直接表现为 not-found。

**只持久化 message 并丢弃 chunk。** 否决：`SessionEvent.seq` 是仅追加序号，source-event 引用还可能指向 chunk 序号。删除行会产生空洞，使校验、恢复和修复不正确。打包可以减少物理行数，同时保留完整逻辑流。

**每个事件同步写入，或在本后端加入 Kafka/Outbox。** 基础版本暂不采用：`PersistenceCoordinator` 已经提供有界异步 write-behind，其 flush listener 定义持久化屏障。CDC、Redis、Elasticsearch projection 和 Outbox 属于独立消费者，等到失败与重试契约明确后再加入。

**向插件暴露原始 `mysql2` 连接。** 否决：调用者可能提前释放连接、修改 session 状态，或在协调器事务之外提交。回调范围的 façade 让这些操作由 `dsh-mysql` 统一管理。

## 后果

插件可以与现有 SQLite 或 JSONL 提供方并列挂载，并用一个 MySQL 数据库承载多个可信租户运行时。每条 SQL 都同时按租户和配置的用户 scope 过滤，批量原子性由 InnoDB 事务保证。chunk 较多的会话使用更少物理行，同时保持精确事件回放。第一版用户桥接刻意要求一个 Provider 实例绑定一个可信 owner；请求级 `AuthenticatedCall` 授权和共享进程多路复用仍是后续工作。Redis 实时流、Kafka/CDC、Elasticsearch projection 和 Outbox 投递仍由独立消费者负责。生产 schema migration 仍应由后续共享 migration service 负责；当前插件建立并校验自己的版本化 schema。

## 测试

MySQL 服务测试覆盖事务提交/回滚、façade 限制、租约失效、连接池清理和销毁排空。User Provider 测试覆盖生命周期和租户隔离。MySQL 持久化集成测试使用 Docker MySQL 启动真实 Cordis 组合，验证打包 chunk 的往返、序号重建和物理行数减少，将 session 绑定到一个用户，并断言另一个用户无法加载或列出它。
