# @deepseek-ai/dsh-session-persistence-mysql

[English](README.md) | 中文

面向用户范围的 MySQL `SessionPersistence` 提供方。它复用 `PersistenceCoordinator` 的有界后台写入、checkpoint、恢复和销毁流程，并使用 `@deepseek-ai/dsh-mysql` 统一管理连接和事务。普通会话事件按记录保存，连续的 `assistant/chunk` delta run 使用 gzip 无损打包；读取时展开为原始逻辑事件。

## 配置

| 配置键 | 必需 | 含义 |
| --- | --- | --- |
| `ownerUserId` | 是 | 绑定到此 Provider 实例的可信认证用户身份。Session header 必须携带相同的 user id。 |
| `preparedSessionCacheSize` | 否 | coordinator 保留的 detached preparation 数量上限；默认为共享持久化默认值。 |
| `writeBatchMaxDelayMs` | 否 | 持久化后台批次的最大有意等待时间；默认为共享持久化默认值。 |

插件要求 `ctx.mysql`、`ctx.users` 和 `ctx.sessions`，并在暴露后端前确认配置的 owner 用户处于 active。MySQL schema 对象归本包所有，不会作为模型工具或动态 Host 服务暴露。

## 持久化与 chunk 存储

`appendBatch` 会锁定 session 行、校验 `ownerUserId` 所有者和下一条期望序号、插入不可变记录、推进 revision 和序号游标，并在一个事务中提交。事务失败时 session 保持不变。新数据库不再创建 `tenant_id` 列。

数据库保存的是打包表示，而不是有损的只保留消息投影。`assistant/chunk` run 使用现有 session chunk-row 编码并压缩为一行；读取时校验 checksum、序号范围和事件数量。`assistant/message`、`tool/call`、`tool/result`、用户消息和 turn 边界在逻辑上都保留，可以完整重建。

## 模型体验

### MySQL 会话持久化

#### 模型看到的内容

没有直接内容。该包不增加工具、提示词、消息或面向模型的目录项。会话历史仍然来自 `ctx.sessionPersistence` 和 session event log。

#### Token 影响

没有直接影响。数据库写入发生在模型请求之外。

#### KV Cache 影响

没有直接影响。持久化不会改变模型请求前缀。

## 已知限制与暂缓事项

- 第一版用户桥接实现把一个 Provider 实例绑定到一个可信 `ownerUserId`；请求级认证和租户范围隔离暂缓。
- 检测到仍含 `tenant_id` 的旧 schema 时会在启动时拒绝；这个未发布版本需要重建数据库，或先执行显式的 user-id-only migration。
- 当前 schema 在插件初始化期间建立；生产部署前可由共享 migration 服务负责版本化 migration 执行。
- 原始流 artifact、Redis 实时流、Kafka/CDC 投递、Elasticsearch projection 和 outbox 记录尚未实现。
