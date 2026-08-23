# Agent Note：dsh-user 的 MySQL Provider

Status: proposed

[English](2026-08-24-dsh-user-mysql-provider.md) | 中文

## 问题

解耦交付方案要求每个插件消费未修改的上游包。耦合候选实现给 `packages/multi/mysql` 增加了 `transaction()` 便利方法，让 Provider 把工作包成一个事务单元；保持这种形态会让每个可选 Provider 依赖本地打过补丁的 DSH 发行版。用户身份 Service Definition 也需要一个具体 Provider，让 `ctx.users` 拥有持久化存储。

## 提案

在 `packages/identity/user-mysql` 新增 `@deepseek-ai/dsh-user-mysql` 作为 `ctx.users` 的 MySQL Service Provider。Provider 拥有 `dsh_users` 表，提供幂等的版本化 schema，并支持创建、读取、require-active、禁用和列举操作，以及本地开发的可选 bootstrap 用户。

### 事务归属

Provider 通过上游 `ctx.mysql.connection(callback)` 租用单条连接，并在该租期内自行执行 `beginTransaction`、`commit` 和 `rollback`。不向上游 `packages/multi/mysql` 添加便利方法；回调失败、commit 失败和连接恢复仍由上游租约契约保证。

### Schema 与归属

Schema 通过单例状态表记录版本并幂等创建。新数据库不包含 `tenant_id`；归属只按 `user_id` 限定。启动时检测到仍含 `tenant_id` 的旧表会直接拒绝，而不是静默迁移。

### Bootstrap 用户

可选的 `bootstrapUserId` 在激活时创建本地开发用户。它不是认证机制；凭据和外部身份映射仍属于独立能力。

## 考虑过的替代方案

**给上游 MySQL 服务添加 `transaction()`。** 不采用：每个可选 Provider 都会因此要求本地打过补丁的 DSH 发行版，颠倒依赖方向并迫使 core 包变更。

**把归属委托给全局租户字段。** 不采用：共享进程的多租户服务需要先有请求级身份机制；在该机制出现前，本 Provider 保持一个运行时一个用户的姿态。

## 验收标准

- 不修改 `packages/multi/mysql` 或任何其他既有包。
- Provider 在单条上游连接租期内自行管理事务序列。
- Schema 创建幂等且带版本检查；含 `tenant_id` 的旧表被拒绝。
- 创建、读取、require-active、禁用、列举、重复拒绝和 bootstrap 行为由单元测试与 MySQL 集成测试覆盖。

## 风险

事务正确性依赖上游租约契约：commit 或 rollback 失败后，租用连接仍必须可恢复，这是上游服务保证的。并发重复创建依赖唯一键与 `ER_DUP_ENTRY` 映射；数据库配置不当可能暴露驱动特有错误。
