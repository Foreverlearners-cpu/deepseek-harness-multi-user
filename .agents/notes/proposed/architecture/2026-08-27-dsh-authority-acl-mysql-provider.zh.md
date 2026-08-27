# Agent Note: MySQL ACL 策略源 Provider

Status: proposed

[English](2026-08-27-dsh-authority-acl-mysql-provider.md) | 中文

## 问题

与 Provider 无关的 [`dsh-authority-acl` 对象路线](2026-08-27-dsh-authority-acl-object-route.md)需要为 `resource_action_grants` 提供持久化多进程存储，同时不能把 Effective、角色目录或连接池所有权转移进对象服务。团队主体必须保持一行 `g:team-rd`。记录转授授权的写入不得在本包调用 `decide`。一个 resource revision 上的授权不得与另一资源或另一 revision 混合。

## 提案

增加 `@deepseek-ai/dsh-authority-acl-mysql`，作为基于 Host-only `ctx.mysql` 连接服务的具体 `AclPolicySource`。插件提供用于写入的 `ctx.authorityAclMysql`，向 `ctx.authorityAcl` 注册自身，并拥有 `dsh_acl_schema`、`dsh_resource_action_grants`、索引、SQL、schema version 和存储错误映射。它既不修改 `dsh-authority-acl`，也不扩展 `dsh-mysql`。

Schema version 1 为每个 `(resource_type, resource_id, resource_revision, subject_ref)` 保存一行，包含 JSON Use/Delegate 数组、`active`/`revoked` 状态和单调行 revision。团队主体存为 `g:team-rd`。`listGrants` 返回一个资源 type 和 id 上的 active 行。`listGrantsAt` 返回一个 resource revision 上的 active 行。

`grant` 和 `revoke` 锁定目标槽位、写入、再读取并提交。它们不调用 `ctx.authority.decide` 或 `require`。意外 SQL 和回滚故障变成 `provider-unavailable`。该源不调用 `ctx.teams`，也不会把团队授权展开成按用户一行。

## 备选方案

**把 SQL 放进 `dsh-authority-acl`。** 拒绝，因为 Service Definition 必须可与其他存储 Provider 配合使用，并且不能要求 Host 数据库连接。

**把团队授权复制到每个用户行。** 拒绝，因为加入和踢人会改写 ACL，表会随成员增长。授权保持 `g:team-rd`。

**在 `grant` 内调用 `decide`。** 拒绝，因为 Effective 和允许/拒绝属于 `dsh-authority`。本包只持久化已经授权的写。

**只按资源 type 和 id 做键。** 拒绝，因为同一资源的两个 revision 会共用一个槽位，`listGrantsAt` 无法隔离它们。

## 后果

该 Provider 为一个 MySQL-backed 部署提供按 resource revision 隔离的持久对象授权，同时角色目录和 Effective 保持独立。研究团队的 execute 授权在成员加入后仍是一行。schema version 不匹配会使启动失败。

## 验收标准

- 插件实现 `AclPolicySource`，向 `ctx.authorityAcl` 注册，并且不拥有 `principal_roles` 数据。
- 团队授权持久化为一行 `g:team-*`，并且不按成员复制。
- `listGrantsAt` 只返回所请求的 resource revision，不返回另一资源。
- `grant` 不调用 `ctx.authority.decide`。
- 共享的 `dsh-authority-acl` contract 在该 Provider 上通过。
- 聚焦无密钥测试满足仓库逐文件覆盖率门禁；真实 MySQL 验证继续由 `DSH_MYSQL_TEST_URL` 控制。

## 风险

- MySQL DDL 独立提交，因此后续 schema 初始化失败时，启动可能留下 version metadata 或表。再次激活会确定性验证并补全相同的 version-1 schema。
- Commit 失败可能使调用方无法确定结果。Provider 报告 `provider-unavailable`，并且不会重试可能已经到达服务器的修改。
- JSON Action 数组在读取时需要解析校验；格式错误的已存数组是 `provider-unavailable`。

## 验证

共享对象路线 contract 在有状态 MySQL test double 上执行，并种入一条 `g:team-rd` execute 授权。Provider 测试固定 schema compatibility、团队主体单行、资源和 revision 隔离、写入时不调用 `decide`、撤销、写入锁失败和存储错误脱敏。使用 `DSH_MYSQL_TEST_URL` 的环境门控测试覆盖真实服务器上的同样隔离。
