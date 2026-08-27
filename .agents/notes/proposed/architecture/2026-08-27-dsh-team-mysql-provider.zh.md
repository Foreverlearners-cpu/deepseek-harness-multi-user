# Agent Note: MySQL team-directory Provider

Status: proposed

[English](2026-08-27-dsh-team-mysql-provider.md) | 中文

## 问题

与 Provider 无关的 [`dsh-team` 目录](2026-08-26-dsh-team-directory-service.md)需要持久化多进程存储，同时不能把角色、对象授权或连接池所有权转移进团队服务。团队行必须保留单一 `tenant_id`。踢人必须在同一事务中修改成员状态和 revision，并且 live event 必须等提交之后再发。

## 提案

增加 `@deepseek-ai/dsh-team-mysql`，作为基于 Host-only `ctx.mysql` 连接服务的具体 `TeamDirectory` 子类。Provider 拥有 `dsh_team_schema`、`dsh_teams`、`dsh_team_memberships`、索引、SQL、schema version、cursor 编码和存储错误映射。它既不修改 `dsh-team`，也不扩展 `dsh-mysql`。

Schema version 1 为每个由 Provider 生成的稳定 UUID 保存一行带有必填 `tenant_id` 的团队，并为每个 `(team_id, user_id)` 保存一个当前成员槽位。成员表复制 `tenant_id` 以支持按租户列出用户团队，并且不保存 action、角色或授权列。对已 removed 的配对再次加入会用新的 `membership_id` 和 revision 1 更新同一唯一槽位。

团队修改锁定团队行。创建成员时先锁团队行再锁成员槽位，并拒绝声称租户与锁定团队所属租户不一致的插入。踢人是把成员状态更新为 `removed`，并在同一次 `UPDATE` 中增加 revision。基础服务只在该事务提交后发出 `team/membership-changed`。意外 SQL 和回滚故障变成 `provider-unavailable`。

列表 cursor 编码 version、排他的 `membership_id` 下界、可选状态过滤，以及团队或「用户加租户」范围。Cursor 不能在不同过滤条件或范围下复用。

## 备选方案

**把 SQL 放进 `dsh-team`。** 拒绝，因为 Service Definition 必须可与其他存储 Provider 配合使用，并且不能要求 Host 数据库连接。

**把 RoleUse 或对象授权 action 存进成员行。** 拒绝，因为踢人和成员可用性是目录事实；action 属于后续的 `dsh-auth-rbac` 和 `dsh-authority-acl`。把团队展开成按用户一行的授权会撑爆表。

**使用 offset pagination。** 拒绝，因为并发插入和生命周期变化会使 offset 跳过或重复无关行。

**在事务内发布 live event。** 拒绝，因为 listener 可能在持锁期间阻塞或失败。持久投递需要后续 transactional outbox。

## 后果

该 Provider 为一个 MySQL-backed 部署提供持久团队与成员生命周期和 revision 语义，同时角色和对象授权保持独立。外部租户不能对已锁定的团队行插入成员。软删除团队和已撤销成员槽位保持可寻址。schema version 不匹配会使启动失败。

## 验收标准

- 插件通过 `ctx.mysql` 提供未改变的 `ctx.teams` API，并且不拥有角色或对象授权数据。
- 团队行持久化 `tenant_id`；成员行不持久化 action 列。
- 踢人在同一事务中更新状态和 revision，基础服务在提交前不发出事件。
- 声称租户不拥有锁定团队的成员插入以 `tenant-mismatch` 失败。
- 聚焦无密钥测试满足仓库逐文件覆盖率门禁；真实 MySQL 验证继续由 `DSH_MYSQL_TEST_URL` 控制。

## 风险

- MySQL DDL 独立提交，因此后续 schema 初始化失败时，启动可能留下 version metadata 或表。再次激活会确定性验证并补全相同的 version-1 schema。
- Commit 失败可能使调用方无法确定结果。Provider 报告 `provider-unavailable`，并且不会重试可能已经到达服务器的修改。
- UUID key 顺序分散插入，但不保留团队或成员创建顺序。

## 验证

共享 Provider suite 在有状态 MySQL test double 上执行。Provider 测试固定 schema compatibility、成员表不含 action 列、跨租户插入拒绝、踢人回滚、keyset/filter/scope cursor 验证、锁顺序和存储错误脱敏。使用 `DSH_MYSQL_TEST_URL` 的环境门控测试覆盖并发踢人 revision 冲突。
