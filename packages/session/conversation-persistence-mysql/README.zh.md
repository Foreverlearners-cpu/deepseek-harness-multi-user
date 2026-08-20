# `@deepseek-ai/dsh-conversation-persistence-mysql`

[English](README.md) | 中文

该插件提供 ToC 对话读写模型。它的 `./session-persistence` 入口是 MySQL Web profile 使用的 AgentLoop 兼容恢复适配器；仍需无损事件日志回放的部署可以继续使用兼容提供方 `@deepseek-ai/dsh-session-persistence-mysql`。

## 持久化边界

- `assistant/chunk`、推理增量和工具调用增量只保留在实时 `Session` 内存中并流式发送到 UI。
- 调用方在一个轮次结束后追加一条最终 `user/message`、`assistant/message` 或 `tool/result` 记录；`appendMessages()` 可以在一个 MySQL 事务中提交整个轮次。
- 同一个事务记录模型 attempt 和语义 Outbox 行；`./outbox-consumer` 可以轮询这些记录，并以幂等方式扇出到 Kafka、Redis 和 Elasticsearch。下游失败不会回滚 MySQL。
- 中断生成使用一条 `status: 'partial'` 或 `'failed'` 的 `assistant/message` 表示，恢复不需要 chunk 行。
- 如果轮次完成组装后 MySQL 暂时不可用，可选 JSONL 持久化 spool 只保存最终消息命令，并在启动时重试。
- JSON 内容和有大小限制的 `extensions` 字段会在 SQL 参数发送前完成校验。

## 文件

`saveFile()` 将字节委托给必需的 `fileStorage` 服务，再把元数据提交到 MySQL。随项目提供的 `@deepseek-ai/dsh-file-storage` 使用本地内容寻址布局（`objects/<sha256 前两位>/<sha256>`）。MySQL 保存摘要、大小、媒体类型、提供方名称、存储 key、用户归属和消息关联，不保存大 BLOB。提供方根目录独立配置（Web profile 使用 `$DSH_HOME/conversation-files/v1`）。

## Cordis 组合

```ts
export {}
declare const ctx: { plugin(plugin: unknown, config?: unknown): Promise<unknown> }
declare const Mysql: unknown
declare const MysqlUserService: unknown
declare const FileStorageService: unknown
declare const MysqlConversationPersistence: unknown
declare const MysqlRuntimeConfigStore: unknown
declare const mysqlConfig: unknown
declare const userId: string
await ctx.plugin(Mysql, mysqlConfig)
await ctx.plugin(MysqlUserService, { bootstrapUserId: userId })
await ctx.plugin(FileStorageService, { root: 'C:/dsh-data/conversation-files/v1' })
await ctx.plugin(MysqlConversationPersistence, { userId })
await ctx.plugin(MysqlRuntimeConfigStore)
```

`userId` 是 Host 组合插件时提供的可信认证上下文。每个 conversation、message、attempt 和 file 查询都包含该用户范围；单独的 Session id 不能作为授权凭据。MySQL 在 conversation、message、attempt、conversation file 和 Outbox 行中直接保存 `user_id`，并使用 `(session_id, user_id)` 联合外键保证子行与会话归属一致。

## 模型体验

### 仅消息持久化

#### 模型看到的内容

插件不贡献提示词或工具 schema。它为恢复重建最终的 `user/message`、`assistant/message` 和 `tool/result` 行，同时让流式 chunk 留在内存中而不进入持久化消息投影。

#### Token 影响

正常运行不直接增加 token；持久化和重试元数据只在 Host 侧处理。如果中断的工具调用没有持久结果，恢复适配器可能追加一条简短的未知结果。

#### KV Cache 影响

成功写入不会影响 KV Cache。恢复的会话复用持久化消息前缀，恢复结果追加在该前缀之后。

## 已知限制与暂缓工作

- MySQL 是消息行的权威来源，但可选 Outbox 消费者是至少一次投递，需要下游按事件幂等。
- 文件字节使用本项目族中的本地内容寻址提供方；S3/MinIO 适配器仍暂缓。
- 外部副作用与结果之间发生崩溃时无法证明 exactly-once；恢复会记录未知结果，不会自动重试。
