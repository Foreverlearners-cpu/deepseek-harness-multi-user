# Agent Note：dsh-session-persistence-mysql Provider

Status: proposed

[English](2026-08-24-dsh-session-persistence-mysql-provider.md) | 中文

## 问题

解耦交付方案禁止在 core `SessionHeader` 或 `CreateSessionOptions` 上新增 `userId`，也禁止给上游 MySQL 服务添加 `transaction()` 便利方法。耦合候选实现两样都做了：会话头携带所有者，Provider 调用 `ctx.mysql.transaction(...)`。用户范围的 MySQL `SessionPersistence` Provider 必须把所有权放在自己的 schema 中，并在上游连接租期内自行管理事务序列。

## 提案

在 `packages/session/session-persistence-mysql` 新增 `@deepseek-ai/dsh-session-persistence-mysql` 作为既有 `SessionPersistence` 服务的 MySQL 实现。它复用 `PersistenceCoordinator` 完成有界写后置、检查点、恢复和销毁，把打包的逻辑事件记录（chunk run 以 gzip 压缩）连同校验和一起存储，并在加载时精确还原。

### 所有权

一个 Provider 实例绑定一个配置的 `ownerUserId`。每次读取、列举和追加都会按 Provider 自有的 `owner_kind`/`owner_id` 列过滤或盖章；`SessionHeader` 不携带用户身份。配置的所有者必须处于 active（`ctx.users.requireActive`），Provider 才会暴露后端。

### 事务

`appendBatch` 通过 `ctx.mysql.connection(callback)` 租用单条连接，自行执行 `beginTransaction`/`commit`/`rollback`，锁定会话行，校验存储的所有者和下一条期望序号，插入不可变记录，并推进 revision 与游标。不向上游 `packages/multi/mysql` 添加便利方法。

## 考虑过的替代方案

**在 core 会话头新增 `userId`。** 不采用：可选持久化会把身份模型施加到每个 DSH 部署，并使 core 包依赖可选插件约定。

**给上游 MySQL 服务添加 `transaction()`。** 不采用：Provider 必须消费未修改的上游包；上游租约已经允许在回调内执行 begin、commit 和 rollback。

## 验收标准

- 不修改 `packages/core/session`、`packages/core/agent`、`packages/core/agent-loop` 或 `packages/multi/mysql`。
- 所有权由 Provider 自有的 schema 列强制，而不是由会话头字段承担。
- `appendBatch` 在单条上游连接租期内自行管理事务；失败会回滚并保持会话不变。
- 往返、chunk 打包、跨用户拒绝和禁用所有者启动由 MySQL 集成测试与事务单元测试覆盖。

## 风险

事务正确性依赖上游租约契约在 commit 或 rollback 失败后恢复连接。序号校验按会话单写者设计；并发写者会被锁定行检查拒绝。该 Provider 按租户运行时绑定：共享进程的请求级身份暂缓。
