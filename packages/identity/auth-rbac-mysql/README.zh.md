# @deepseek-ai/dsh-auth-rbac-mysql

[English](README.md) | 中文

[`dsh-auth-rbac`](../auth-rbac) `RbacPolicySource` 的 MySQL Service Provider。它通过共享的 `dsh-mysql` 连接服务提供 `ctx.authRbacMysql`，向 `ctx.authRbac` 注册自身，并且只拥有 RBAC schema 和 SQL。

## 组合

先挂载 `ctx.auth`、`ctx.authority`、`ctx.authRbac` 和一个 [`dsh-mysql`](../../multi/mysql) 服务，再挂载本插件。插件激活时会创建或验证 `dsh_rbac_schema` metadata 表，以及 `dsh_role_action_grants` 与 `dsh_principal_roles` 数据表，然后把本实例注册为唯一策略源。已有 schema version 若不等于 `AUTH_RBAC_MYSQL_SCHEMA_VERSION`，激活会失败；这个预发布 Provider 不迁移不兼容数据。

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: auth
  package: '@deepseek-ai/dsh-auth'
- name: authority
  package: '@deepseek-ai/dsh-authority'
- name: authRbac
  package: '@deepseek-ai/dsh-auth-rbac'
- name: authRbacMysql
  package: '@deepseek-ai/dsh-auth-rbac-mysql'
```

Consumer 通过 `ctx.authRbacMysql` 写入角色和绑定，并通过 `ctx.authRbac` 求值：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-auth-rbac'
import '@deepseek-ai/dsh-auth-rbac-mysql'
import { roleId } from '@deepseek-ai/dsh-auth-rbac'
import { actionCode } from '@deepseek-ai/dsh-authority'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'

export async function grantResearchRunner(ctx: Context): Promise<void> {
  await ctx.authRbacMysql.putRole({
    roleId: roleId('runner'),
    use: [actionCode('plugin:read'), actionCode('plugin:execute')],
    delegate: [],
  })
  await ctx.authRbacMysql.assign({
    userId: userId('user-1'),
    tenantId: tenantId('tenant-1'),
    teamId: teamId('team-rd'),
    roleId: roleId('runner'),
  })
}
```

只能挂载一个 `ctx.authRbac` Provider 和唯一一个策略源。本包没有配置项，因为表名、索引和 schema identity 是由本包拥有的持久格式常量，不是部署调节项。

## 持久化

`dsh_role_action_grants` 按角色 id 保存一行，包含 JSON 格式的 Use 与 Delegate Action 数组、单调递增 revision 和更新时间戳。替换角色的 Action 集合会增加 revision，因此后续 `listRoleActions` 和 `evaluate` 不能复用上一份集合。

`dsh_principal_roles` 按 `(user_id, tenant_id, team_id, role_id)` 保存一个当前槽位，并带有 `active`/`revoked` 状态和单调递增 revision。`team_id` 是主键的一部分，因此同一用户可以在不同团队持有不同角色，而这些集合不会混在一起。`listPrincipalRoles` 同时过滤 `userId`、`tenantId`、`teamId` 和 `active`。撤销在同一次更新中把状态设为 `revoked` 并增加 revision。对已 revoked 的槽位再次分配会以 revision 1 恢复为 `active`。

本 Provider 不存储对象授权，不计算 Effective，也不调用 `ctx.tenants` 或 `ctx.teams`。连接、SQL、异常数据库行和事务故障统一变成 `provider-unavailable`，不会暴露 SQL 或 driver diagnostics。

## 模型体验

### MySQL 角色授权

#### 模型看到什么

什么也看不到。该 Provider 仅在 Host 中运行，不注册工具、prompt、消息或 Session event。此 Provider 提交角色或绑定变更后，`ctx.authRbac.evaluate` 仍只在 Host 中可见。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

与模型请求无关：数据库读取和修改不会改变请求前缀。

## 已知限制和延后工作

- **仅支持 schema version 1** - 不兼容版本会导致激活失败；承诺持久兼容性前，后续版本必须增加显式 migration。
- **没有对象授权** - 资源 ACL 行属于 `dsh-authority-acl`。
- **没有 Effective 计算** - 同一团队交差仍由 `dsh-authority` 负责。
- **没有团队成员 JOIN** - 撤销是 principal-role 状态变更；本 Provider 不读取 `ctx.teams`。
- **单 database binding** - 本 Provider 使用唯一注入的 `ctx.mysql` 服务，不按 request 或 tenant 选择数据库。
