# @deepseek-ai/dsh-auth-starter

[English](README.md) | 中文

只负责组合认证套件。默认入口挂载完整的 MySQL 账号流程；`@deepseek-ai/dsh-auth-starter/minimal` 在其他插件提供的存储服务上挂载认证 Consumer。Starter 不拥有用户数据、Route、授权规则、签名默认值或管理员策略。

## 完整 MySQL 套件

默认 Function Plugin 按依赖顺序在同一个 Fiber 中挂载 `dsh-mysql`、`dsh-user-mysql`、`dsh-user-credential-mysql`、`dsh-auth-token-mysql`、`dsh-account`、`dsh-account-mysql`、`dsh-auth`、`dsh-auth-password`、`dsh-auth-jwt`、`AccountAdministrationService` 和 `dsh-auth-gateway`。卸载会移除完整子树，并由 MySQL 连接服务排空操作。

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
    gateway:
      allowedOrigins: [https://app.example]
```

JWT Secret 必须是包含 32-128 字节的规范 Base64url 值。MySQL 凭证和 JWT Keyring 都是必填项；Starter 不提供生产 Secret。Key Material 无效、数据库不可用、已存在其拥有的 Service、Provider 冲突或缺少注册操作 Provider 都会使启动失败。JWT 签发与校验保留 `dsh-auth-jwt` 拥有的双 Token 行为：Access 与 Refresh JWT 是不同的签名产物，只能进入各自流程；Refresh 轮换还会检查服务端 Token Family 状态。

Starter 会挂载 `AccountAdministrationService`，以便授权插件随后注册。Starter 绝不注册管理员 Authorizer，因此管理员操作在显式策略 Provider 生效前一律默认拒绝；它不会伪造 RBAC。

## 自定义 Provider 套件

`./minimal` 入口要求已经存在 `users`、`userCredentials`、`authTokens` 与 `accounts` 服务。它们的 Provider Bundle 必须先注册持久化账号注册操作 Provider，再发布 `authProvidersReady` Service Marker。该 Marker 防止 Loader 仅因 Service Object 已出现，就在 Registry Effect 完成前启动 Consumer。

```ts
import type { Context } from '@deepseek-ai/cordis'

declare const myOperations: Parameters<Context['accounts']['registrationOperations']['register']>[0]
const AUTH_PROVIDER_READINESS = 'authProvidersReady'

export async function apply(ctx: Context): Promise<void> {
  const accounts = ctx.get('accounts') as Context['accounts']
  ctx.effect(() => accounts.registrationOperations.register(myOperations))
  ctx.provide(AUTH_PROVIDER_READINESS, true)
}
```

把该 Provider Plugin 与 Minimal Starter Row 并列放置。Minimal Row 会等待五项 Inject，挂载 `dsh-auth`、Password 与 JWT Provider、管理员服务和 Gateway，再检查 Provider 注册。只有全部必要注册提交后才能发布 Marker；Provider Fiber 卸载时必须移除它。

## 运行时使用

Adapter 通过 [`ctx.authGateway`](../auth-gateway/README.md) 完成注册、密码登录、Access Bearer 认证、Refresh Cookie 加 CSRF 轮换和登出。`dsh-account` 负责协调 User 与 Credential；Starter 不增加另一套 API。速率限制、锁定、找回、RBAC、租户派生和 HTTP Route 序列化仍属于独立插件。

## 模型体验

### 认证组合

#### 模型看到什么

什么也看不到。`ctx.authGateway`、凭证、身份 Call 与启动检查都保留在 Host 内。

#### Token 影响

`0`。本包不注册 Prompt Section、Tool 或 Session Event。

#### KV Cache 影响

`0` 前缀变化。认证组合不会改变模型请求前缀。

## 已知限制与延期工作

- 默认套件支持一个 MySQL Pool 和内置 Password/JWT 流程；API Key 与其他认证方式仍需独立组合。
- 本包返回传输无关 Gateway Service，而不是 HTTP Route 或框架 Middleware。
- 自定义 Provider Bundle 负责其 Readiness Marker 的准确性和卸载顺序。
