# @deepseek-ai/dsh-authority-acl-mysql

[English](README.md) | 中文

[`dsh-authority-acl`](../authority-acl) `AclPolicySource` 的 MySQL Service Provider。它通过共享的 `dsh-mysql` 连接服务提供 `ctx.authorityAclMysql`，向 `ctx.authorityAcl` 注册自身，并且只拥有对象授权 schema 和 SQL。

## 组合

先挂载 `ctx.auth`、`ctx.authority`、`ctx.teams`、`ctx.authorityAcl` 和一个 [`dsh-mysql`](../../multi/mysql) 服务，再挂载本插件。插件激活时会创建或验证 `dsh_acl_schema` metadata 表和 `dsh_resource_action_grants` 数据表，然后把本实例注册为唯一策略源。已有 schema version 若不等于 `AUTHORITY_ACL_MYSQL_SCHEMA_VERSION`，激活会失败；这个预发布 Provider 不迁移不兼容数据。

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
- name: teams
  package: '@deepseek-ai/dsh-team-mysql'
- name: authorityAcl
  package: '@deepseek-ai/dsh-authority-acl'
- name: authorityAclMysql
  package: '@deepseek-ai/dsh-authority-acl-mysql'
```

Consumer 通过 `ctx.authorityAclMysql` 写入已经授权的 grant，并通过 `ctx.authorityAcl` 求值：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-authority-acl'
import '@deepseek-ai/dsh-authority-acl-mysql'
import { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import { teamId } from '@deepseek-ai/dsh-team'

export async function grantResearchTeamExecute(ctx: Context): Promise<void> {
  await ctx.authorityAclMysql.grant({
    resource: { type: resourceType('plugin'), id: resourceId('plugin-100') },
    subject: { kind: 'team', id: teamId('team-rd') },
    use: [actionCode('plugin:execute')],
    delegate: [],
  }, 1)
}
```

只能挂载一个 `ctx.authorityAcl` Provider 和唯一一个策略源。本包没有配置项，因为表名、索引和 schema identity 是由本包拥有的持久格式常量，不是部署调节项。`grant` 和 `revoke` 只持久化行；它们不调用 `ctx.authority.decide` 或 `require`。

## 持久化

`dsh_resource_action_grants` 按 `(resource_type, resource_id, resource_revision, subject_ref)` 保存一行。团队主体是编码后的 `g:team-rd`，并且保持一行。增加或踢出成员不会插入或删除授权行。Use 与 Delegate Action 数组是 JSON 列。替换一条 grant 会增加行 revision。撤销在同一次更新中把状态设为 `revoked` 并增加 revision。

`listGrants` 返回一个资源 type 和 id 上的 active grant。`listGrantsAt` 返回一个 resource revision 上的 active grant，因此 plugin-100 revision 1 不能读到 revision 2 或 plugin-200。连接、SQL、异常数据库行和事务故障统一变成 `provider-unavailable`，不会暴露 SQL 或 driver diagnostics。

本 Provider 不存储 `principal_roles`，不计算 Effective，也不调用 `ctx.teams`。实时成员匹配仍由 `dsh-authority-acl` 负责。

## 模型体验

### MySQL 对象授权

#### 模型看到什么

什么也看不到。该 Provider 仅在 Host 中运行，不注册工具、prompt、消息或 Session event。此 Provider 提交授权变更后，`ctx.authorityAcl.evaluate` 仍只在 Host 中可见。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

与模型请求无关：数据库读取和修改不会改变请求前缀。

## 已知限制和延后工作

- **仅支持 schema version 1** - 不兼容版本会导致激活失败；承诺持久兼容性前，后续版本必须增加显式 migration。
- **没有角色目录** - 角色主体匹配仍询问已注册的 fact source；本包不读取 `principal_roles`。
- **没有 Effective 计算** - 同一团队交差仍由 `dsh-authority` 负责。
- **写入时不做 decide** - 调用方必须在调用 `grant` 前完成授权；本 Provider 不再检查。
- **单 database binding** - 本 Provider 使用唯一注入的 `ctx.mysql` 服务，不按 request 或 tenant 选择数据库。
