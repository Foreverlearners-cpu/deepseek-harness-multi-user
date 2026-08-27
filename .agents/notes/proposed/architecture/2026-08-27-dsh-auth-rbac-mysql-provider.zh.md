# Agent Note: MySQL RBAC 策略源 Provider

Status: proposed

[English](2026-08-27-dsh-auth-rbac-mysql-provider.md) | 中文

## 问题

与 Provider 无关的 [`dsh-auth-rbac` 角色路线](2026-08-26-dsh-auth-rbac-role-route.md)需要为 `principal_roles` 和 `role_action_grants` 提供持久化多进程存储，同时不能把 Effective、对象授权或连接池所有权转移进角色服务。绑定必须包含 `team_id`，这样同一用户才能在不同团队持有不同角色。替换角色的 Action 必须增加 revision，使后续求值不能复用上一份集合。

## 提案

增加 `@deepseek-ai/dsh-auth-rbac-mysql`，作为基于 Host-only `ctx.mysql` 连接服务的具体 `RbacPolicySource`。插件提供用于写入的 `ctx.authRbacMysql`，向 `ctx.authRbac` 注册自身，并拥有 `dsh_rbac_schema`、`dsh_role_action_grants`、`dsh_principal_roles`、索引、SQL、schema version 和存储错误映射。它既不修改 `dsh-auth-rbac`，也不扩展 `dsh-mysql`。

Schema version 1 为每个 `role_id` 保存一行带有 JSON Use/Delegate 数组和单调 revision 的角色。替换这些数组会增加 revision。主体绑定使用主键 `(user_id, tenant_id, team_id, role_id)`，并带有 `active`/`revoked` 状态。`listPrincipalRoles` 只匹配全部三个身份字段且状态为 `active` 的行。撤销在同一语句中更新状态和 revision。对已 revoked 的槽位再次分配会以 revision 1 恢复为 `active`。

写入会锁定目标行、校验、写入、再读取已提交行，然后提交事务。意外 SQL 和回滚故障变成 `provider-unavailable`。该源不调用 `ctx.tenants` 或 `ctx.teams`。

## 备选方案

**把 SQL 放进 `dsh-auth-rbac`。** 拒绝，因为 Service Definition 必须可与其他存储 Provider 配合使用，并且不能要求 Host 数据库连接。

**把角色 Action 存进团队成员行。** 拒绝，因为成员可用性是目录事实；把团队展开成按用户一行的授权会撑爆表。角色 Action 留在角色目录中。

**绑定键省略 `team_id`。** 拒绝，因为同一用户会在租户内每个团队持有同一套角色，`evaluate` 无法隔离 RoleUse(T)。

**在求值时 JOIN `dsh_team_memberships`。** 拒绝，因为成员踢人即失效由 `dsh-team` 拥有；本 Provider 撤销 principal-role 行，并且不读取其他包的表。

## 后果

该 Provider 为一个 MySQL-backed 部署提供持久的按团队角色绑定和角色-Action revision，同时对象授权和 Effective 保持独立。在研究团队是 `runner`、在运营团队是 `viewer` 的用户，不会把 `plugin:execute` 泄漏进运营团队的 Use 集合。schema version 不匹配会使启动失败。

## 验收标准

- 插件实现 `RbacPolicySource`，向 `ctx.authRbac` 注册，并且不拥有对象授权数据。
- `principal_roles` 持久化 `team_id`；`listPrincipalRoles` 永不返回其他团队的角色。
- 替换角色 Action 会增加 revision，并改变下一次 `evaluate` 的结果。
- 共享的 `dsh-auth-rbac` contract 在该 Provider 上通过。
- 聚焦无密钥测试满足仓库逐文件覆盖率门禁；真实 MySQL 验证继续由 `DSH_MYSQL_TEST_URL` 控制。

## 风险

- MySQL DDL 独立提交，因此后续 schema 初始化失败时，启动可能留下 version metadata 或表。再次激活会确定性验证并补全相同的 version-1 schema。
- Commit 失败可能使调用方无法确定结果。Provider 报告 `provider-unavailable`，并且不会重试可能已经到达服务器的修改。
- JSON Action 数组在读取时需要解析校验；格式错误的已存数组是 `provider-unavailable`。

## 验证

共享角色路线 contract 在有状态 MySQL test double 上执行，并种入研究团队 runner 与运营团队 viewer 夹具。Provider 测试固定 schema compatibility、绑定键含 `team_id`、同一用户跨团队和跨租户隔离、角色 revision 替换、撤销、写入锁失败和存储错误脱敏。使用 `DSH_MYSQL_TEST_URL` 的环境门控测试覆盖真实服务器上的隔离、revision 替换和撤销。
