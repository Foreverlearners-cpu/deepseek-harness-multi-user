# @deepseek-ai/dsh-auth-gateway

[English](README.md) | 中文

面向 HTTP 与 WebSocket 适配器的传输无关 Host 认证入口。服务提取唯一且有长度限制的凭证载体，把验证委托给 [`ctx.auth`](../auth/README.md)，把公开账号流程委托给 [`ctx.accounts`](../account/README.md)，并只返回固定的 `AuthGatewayError.code` 与 `status`，不携带 Provider 诊断或秘密。

本包不是 HTTP Server 或 Router。框架适配器需要把原生请求转换成结构化 Header、已解析 Cookie、已解码 Query 与 Subprotocol 条目。保留重复条目后，Gateway 才能在大小写折叠后拒绝重复安全字段；适配器必须使用框架维护的 Cookie Parser，不能自行拆分 Cookie Header。

## 配置

`allowedOrigins` 默认是空数组，因此浏览器 refresh 会默认拒绝，直到部署明确列出 `https://app.example` 这样的完整 Origin。Refresh Cookie 默认为 `__Secure-dsh_refresh`，可读 CSRF Cookie 默认为 `__Secure-dsh_csrf`；两者都使用 `Secure`、`SameSite=Strict` 与 `Path=/auth/refresh`，其中 Refresh Cookie 还使用 `HttpOnly`。Cookie 名称、CSRF Header 名称、Refresh Path 和 Origin 均可配置。

`allowWebSocketQueryAccessToken` 默认为 `false`，因为 Query 值容易进入 URL 与日志。只有在 WebSocket 客户端无法设置 Authorization Header 或 Subprotocol，且外围设施已经对 Query 脱敏时才启用。

## 适配器用法

挂载 `dsh-auth`、它的 Bearer JWT Provider、`dsh-account` 与本服务。HTTP 适配器对受保护请求调用 `authenticateHttp()`，并在受保护 Handler 读取身份前把返回的 Host-only Call 交给 `guard()`：

```ts
import type { AuthenticatedCall, GatewayHttpAuthenticationRequest } from '@deepseek-ai/dsh-auth-gateway'
import type { Context } from '@deepseek-ai/cordis'

async function protectedUserId(ctx: Context, request: GatewayHttpAuthenticationRequest): Promise<string> {
  const call: AuthenticatedCall = await ctx.authGateway.authenticateHttp(request)
  return ctx.authGateway.guard(call, current => current.principal.id)
}
```

第一层通过 `dsh-auth-jwt` 验证 JWT 签名、Claims、Token 类型、持久化 Token Family 状态和当前用户状态。`guard()` 随后在使用前调用 `ctx.auth.assertCurrent()`，拒绝已取消或过期的 Call，以及由已被替换 Provider 签发的 Call。`AuthenticatedCall` 绝不能跨进程或进入传输响应。

`login()` 与 `register()` 只接受有长度限制的 Body 密码字段。登录返回 Access Token 与 Set-Cookie 指令，Refresh Token 只存在于 HttpOnly Cookie 指令中。`refresh()` 从该 Cookie 读取秘密，并要求 Origin 与允许列表完全匹配，同时要求 CSRF Header 和可读 Cookie 值相同，然后才委托轮换。`logout()` 先认证 Bearer，再检查当前性，通过 `ctx.accounts` 撤销用户会话并返回清除 Cookie 的指令。Gateway 绝不公开 `ctx.accountAdministration` 方法。

WebSocket 只在握手时通过 Authorization Bearer、Access Cookie、`dsh-auth-bearer.<JWT>` Subprotocol 或显式启用的 `access_token` Query 条目认证，并且只能存在一种。Query 或 Subprotocol 中的 Password 与 Refresh 值始终被拒绝；Refresh 与密码操作仍是 HTTP Body/Cookie 流程。

## 错误映射

适配器可以直接映射 `AuthGatewayError.status` 并按需公开 `code`：`invalid-request`（400）、`unauthenticated`（401）、`forbidden`（403）、`conflict`（409）或 `unavailable`（503）。错误消息固定且不保留 `cause`。结构化请求、Cookie 指令、登录输入与会话结果包含凭证，不得记录日志。

## 模型体验

### 认证传输

#### 模型看到什么

什么也看不到。`ctx.authGateway` 输入、Call、凭证与错误都保留在 Host 内。

#### Token 影响

零。本包不注册 Prompt Section、Tool 或 Session Event。

#### KV Cache 影响

互不相关。认证传输不会改变模型请求前缀。

## 已知限制与延期工作

- 本包返回与适配器无关的 Cookie 指令；各 HTTP 框架适配器负责 Header 序列化与响应投递。
- 注册和登录速率限制、账号锁定、验证码与找回流程属于专用策略插件。
- WebSocket Call 会在握手时和受保护 Handler 使用前检查；如果长连接跨消息保留权限，还需要独立的过期断连策略。
