# @deepseek-ai/dsh-authority-starter

[English](README.md) | 中文

只负责组合授权套件。默认入口挂载完整的 MySQL 授权树；`@deepseek-ai/dsh-authority-starter/minimal` 在其他插件提供的目录与路线之上挂载 decide 入口和账号 authorizer。Starter 不拥有授权、角色目录、默认全允许规则、跨团队并集开关或 JWT 密钥。

## 完整 MySQL 套件

默认 Function Plugin 注入 `mysql`、`auth` 和 `accountAdministration`，然后按依赖顺序在同一个 Fiber 中挂载 `dsh-tenant-mysql`、`dsh-team-mysql`、`dsh-authority`、`dsh-auth-rbac`、`dsh-auth-rbac-mysql`、`dsh-authority-acl`、`dsh-authority-acl-mysql`、`dsh-tenant-authority` 和 `dsh-account-authority`。卸载会移除子树。注入的 MySQL 连接池不在这里创建；先挂载 `dsh-mysql` 或 `dsh-auth-starter`。

```yaml
- id: authentication
  name: '@deepseek-ai/dsh-auth-starter'
  config:
    mysql:
      host: 127.0.0.1
      user: dsh
      password: !!js env.DSH_MYSQL_PASSWORD
      database: dsh
    jwt:
      issuer: https://auth.example
      audience: dsh-web
      activeKeyId: primary
      keys:
        - keyId: primary
          secret: !!js env.DSH_JWT_PRIMARY_KEY
- id: authorization
  name: '@deepseek-ai/dsh-authority-starter'
```

已存在的自有服务、缺失的注入服务，或未注册的子插件都会拒绝启动。该套件不插入角色或对象授权。同一团队的 Effective 仍由 `dsh-authority` 负责。

## 自定义 Provider 套件

`./minimal` 入口要求已有 `auth`、`accountAdministration`、`tenants`、`teams`、`authority`、`authRbac` 和 `authorityAcl` 服务。它们的 Provider 组合必须登记角色与对象源，然后发布 `authorityProvidersReady` 服务标记。该标记防止 Loader 只因为服务对象已经出现、登记尚未完成就开始 Consumer。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RbacPolicySource } from '@deepseek-ai/dsh-auth-rbac'
import type { AclPolicySource } from '@deepseek-ai/dsh-authority-acl'

const AUTHORITY_PROVIDER_READINESS = 'authorityProvidersReady'

function installSources(ctx: Context, rbac: RbacPolicySource, acl: AclPolicySource): void {
  ctx.effect(() => ctx.authRbac.registerSource(rbac))
  ctx.effect(() => ctx.authorityAcl.registerSource(acl))
  ctx.provide(AUTHORITY_PROVIDER_READINESS, true)
}
```

把该 Provider 插件放在 minimal Starter 行旁边。minimal 行等待全部八项注入，挂载 `dsh-tenant-authority` 和 `dsh-account-authority`，然后检查这些服务。只在每项必需登记提交之后发布就绪标记；卸载 Provider Fiber 必须移除它。

## 运行时用法

产品调用方使用 [`ctx.tenantAuthority.decide`](../tenant-authority/README.md) 和 [`ctx.accountAuthority.authorize`](../account-authority/README.md)。本包不增加另一套 API，也不提供默认允许路径。

## 模型体验

### 授权装配

#### 模型可见内容

无。`ctx.tenantAuthority.decide`、`ctx.accountAuthority.authorize`、成员查找和启动检查仅限 Host。

#### Token 影响

无。授权装配不会增加、删除或改写模型输入 token。

#### KV Cache 影响

独立。授权装配不会改动模型可见的请求前缀，因此不会使原本可复用的提供方缓存条目失效。

## 已知限制与延期工作

- **不是 RBAC 引擎** - 该套件只挂载插件。角色目录和对象授权仍由各自所有者负责。
- **没有跨团队并集开关** - Effective 仍是 `dsh-authority` 中的同一团队取交。
- **需要注入的 MySQL 连接池** - 默认入口不创建 `ctx.mysql`，也不创建 JWT 材料。
- **自定义 Provider 组合自行保证就绪标记** 和卸载顺序。
