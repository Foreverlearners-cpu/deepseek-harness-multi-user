# Agent Note：dsh-conversation-persistence-mysql 投影

Status: proposed

[English](2026-08-24-dsh-conversation-persistence-mysql-projection.md) | 中文

## 问题

解耦交付方案把语义会话内容存储视为投影，而不是规范会话事件日志的替代品，并明确把 outbox 投递排除在当前范围外。耦合候选实现正好相反：它暴露了一个基于 message-only 行的 `SessionPersistence` 恢复适配器，在每次提交时写入语义 outbox 行，并在 core `SessionHeader` 上携带用户身份。本插件只把会话、消息、尝试和文件元数据投影到 MySQL，不重定向既有 session-persistence 消费方，也不包含 outbox 机制。

## 提案

在 `packages/session/conversation-persistence-mysql` 新增 `@deepseek-ai/dsh-conversation-persistence-mysql` 作为用户范围的 MySQL 会话内容投影。它拥有 `ctx.conversationPersistence`（会话、消息、尝试和文件元数据）以及包自有的 runtime-config 存储。独立的 `SessionPersistence` 提供方（`@deepseek-ai/dsh-session-persistence-mysql`）继续作为规范事件日志实现；本插件绝不注册 `sessionPersistence`。

### 投影边界

流式 chunk 保留在实时会话内存中。一个轮次在 Provider 自有的一个 MySQL 事务中提交一条最终 `user/message`、`assistant/message` 或 `tool/result` 记录；同一事务记录模型尝试。中断生成以 `partial` 或 `failed` 的 assistant 消息保存。文件字节委托给必需的 `fileStorage` 服务；MySQL 只保存带用户谓词的元数据。

### 所有权

一个插件实例绑定一个配置的 `userId`。每个会话、消息、尝试和文件查询都包含该用户谓词；core `SessionHeader` 不携带用户身份。单独的 session id 永远不能作为授权凭据。

### 范围外

语义 outbox 扇出（Kafka/Redis/Elasticsearch）和基于 message-only 行的 `SessionPersistence` 恢复适配器不在本分支交付。耦合候选中的 outbox 表和适配器模块被删除，而不是部分交付。

## 考虑过的替代方案

**交付耦合的 `SessionPersistence` 恢复适配器。** 不采用：方案要求语义存储保持为投影，绝不静默重定向 `api/remotes` 或其他既有消费方。

**保留语义 outbox 行和轮询器。** 不采用：用户明确暂缓 outbox 实现；在没有消费方的情况下提交 outbox 行只会交付未使用的机制。

## 验收标准

- 不修改 `packages/core/session`、`packages/core/agent`、`packages/core/agent-loop` 或 `packages/multi/mysql`。
- 插件绝不注册 `ctx.sessionPersistence`；规范会话持久化仍由独立提供方承担。
- 包内不存在 outbox 表、outbox 写入或 outbox 消费模块。
- 会话、消息、尝试和文件元数据操作按用户限定，并由 MySQL 集成测试覆盖。
- 文件字节委托给 `fileStorage` 服务；MySQL 只保存元数据。

## 风险

投影与实时会话是最终一致的：崩溃恢复依赖已组装轮次的持久化 spool 和 `partial`/`failed` 消息行。该 Provider 按租户运行时绑定；共享进程的请求级身份暂缓。
