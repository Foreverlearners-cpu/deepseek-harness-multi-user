# @deepseek-ai/dsh-auth

[English](README.md) | 中文

Host 端的认证契约与运行时。本包根据提交证据的种类精确选择一个认证器（Provider），让该 Provider 验证凭证，并生成不可变的 `AuthenticatedCall`，供后续代码确认其来源。它还会把可选的凭证签发、刷新、查询和吊销操作路由给拥有对应认证方式的 Provider。

这是 P0 阶段的认证骨架。它不解析 JWT 或 API Key，不授予权限，不派生租户范围，也不会自行加入应用套件。这些职责分别属于后续的 Provider、授权、租户、网关和 starter 插件。

## 对外 API

| API | 用途 |
|---|---|
| `ctx.auth.authenticate(attempt)` | 按 `attempt.evidence.kind` 选择 Provider、验证证据并生成 `AuthenticatedCall` |
| `ctx.auth.assertCurrent(value)` | 确认该对象确由当前运行时生成，且它的 Provider、请求状态和有效期仍然有效 |
| `ctx.auth.providers.register(kind, provider)` | 为一种证据和认证方式注册唯一 Provider；返回可重复调用的卸载函数 |
| `ctx.auth.credentials.issue(method, request)` | 让对应认证方式的 Provider 签发凭证 |
| `ctx.auth.credentials.refresh(method, request)` | 让对应 Provider 轮换刷新凭证 |
| `ctx.auth.credentials.inspect(method, request)` | 查询不含秘密值的安全凭证元数据 |
| `ctx.auth.credentials.revoke(method, request)` | 吊销单个凭证、Token 家族或某主体的凭证 |

前两个方法回答的问题不同。`authenticate()` 从不可信的传输证据中建立身份；`assertCurrent()` 不会再次验证 Token，而是检查进程内的值是不是当前运行时之前生成的那个 `AuthenticatedCall`。对象的浅拷贝或 JSON 序列化后再还原的结果都会被拒绝。

## 如何选择认证器

选择规则是确定的：注册表直接使用 `attempt.evidence.kind` 作为键。`bearer` 只选择唯一的 bearer Provider，`api-key` 只选择唯一的 API-key Provider。运行时不会依次尝试多个 Provider，也不会采用“谁先成功就用谁”的方式。同一种证据注册两个 Provider，或者两个 Provider 声明同一种认证方式，都会立即以 `provider-conflict` 失败。

一个 bearer Provider 内部可以支持多个 JWT 签发方。根据 issuer 选择密钥属于该 Provider 内部的 JWT 验证逻辑，不应成为第二套全局 Provider 选择规则。未来由 gateway 拒绝同时携带多种凭证的请求。

## 实现并注入认证器

认证实现首先扩展证据映射，声明它负责的传输数据形状：

```ts
import '@deepseek-ai/dsh-auth/types'

declare module '@deepseek-ai/dsh-auth/types' {
  interface AuthenticationEvidenceMap {
    bearer: { readonly kind: 'bearer'; readonly token: string }
  }
}
```

然后把 Provider 注册为插件自己拥有的 effect。将注册返回的卸载函数交给 `ctx.effect()`，可以保证 HMR、插件启动失败和正常关闭时都会移除路由，并让该次注册生成的旧认证结果立即失效。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { authenticationMethod, credentialId, userId } from '@deepseek-ai/dsh-auth'
import '@deepseek-ai/dsh-auth/types'

declare module '@deepseek-ai/dsh-auth/types' {
  interface AuthenticationEvidenceMap {
    bearer: { readonly kind: 'bearer'; readonly token: string }
  }
}

declare function verifyJwt(token: string, signal: AbortSignal): Promise<{
  subject: string
  jwtId: string
  expiresAt: number
}>

export const inject = ['auth']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.auth.providers.register('bearer', {
    method: authenticationMethod('jwt'),
    async verify(attempt) {
      const claims = await verifyJwt(attempt.evidence.token, attempt.signal)
      return {
        principal: { kind: 'user', id: userId(claims.subject) },
        credentialId: credentialId(claims.jwtId),
        authenticatedAt: Date.now(),
        expiresAt: claims.expiresAt,
      }
    },
  }))
}
```

上面的 `verifyJwt()` 只是 Provider 专属逻辑的伪代码。原始凭证始终留在 Provider 内部。可以安全返回给调用方的失败应使用 `AuthenticationError`；未预料的内部异常会被统一转换为 `authentication-unavailable`，避免把内部细节暴露给传输层。

凭证生命周期函数是 `provider.credentials` 下的可选成员。Provider 只应实现自己真正拥有存储和吊销语义的操作。调用未实现的操作会得到 `credential-operation-unsupported`。

## 使用认证功能

只有可信的传输适配器才能构造 `AuthenticationAttempt`。它提取且只提取一种凭证，为请求分配 Host 请求 id 和取消信号，完成认证后再把结果交给下游：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { AuthenticatedCall } from '@deepseek-ai/dsh-auth'
import { authenticationRequestId } from '@deepseek-ai/dsh-auth'
import '@deepseek-ai/dsh-auth/types'

declare module '@deepseek-ai/dsh-auth/types' {
  interface AuthenticationEvidenceMap {
    bearer: { readonly kind: 'bearer'; readonly token: string }
  }
}

interface TransportRequest {
  id: string
  bearerToken: string
  signal: AbortSignal
}

export async function authenticateRequest(ctx: Context, request: TransportRequest): Promise<AuthenticatedCall> {
  const call = await ctx.auth.authenticate({
    requestId: authenticationRequestId(request.id),
    channel: 'http',
    evidence: { kind: 'bearer', token: request.bearerToken },
    signal: request.signal,
  })
  return ctx.auth.assertCurrent(call)
}
```

数据流是：传输证据 -> 精确匹配的 Provider -> 已验证身份事实 -> 运行时生成的 `AuthenticatedCall` -> 授权或租户消费者。Token 是 Provider 的输入；`AuthenticatedCall` 才是在进程内传给下游的可信身份。

运行时会发出 `auth/result`，其中包含请求、认证方式、主体、结果和安全的失败类别，不会包含原始 Token 或已签发凭证的秘密值。可选的不变式伴生插件 `@deepseek-ai/dsh-auth/invariant` 会检查这些事件只在认证服务存活时发出。

## 失败语义

| 错误码 | 含义 |
|---|---|
| `unauthenticated` | 证据被拒绝、已过期、已取消，或认证结果不再可用 |
| `authentication-unavailable` | 没有匹配 Provider、验证期间 Provider 被替换，或 Provider 内部失败 |
| `provider-conflict` | 第二个 Provider 声明了已有的证据种类或认证方式 |
| `credential-operation-unsupported` | 所选认证方式没有实现请求的生命周期操作 |

## 模型体验

### 认证状态

#### 模型看到什么

什么也看不到。认证证据、`AuthenticatedCall` 身份事实和 `auth/result` 审计事件只存在于 Host；本包不会注册任何可能向模型暴露它们的提示词片段、工具或会话事件。

#### Token 影响

为零。认证不会增加、删除或改写任何模型输入 Token。

#### KV Cache 影响

相互独立。认证不会改变模型可见的请求前缀，因此不会使本来可以复用的 Provider 缓存条目失效。

## 已知限制与暂缓工作

- **没有具体凭证格式**：JWT 和 API Key 的解析、签名、存储、轮换与吊销属于专用 Provider 插件。
- **没有传输层集成**：gateway 需要提取唯一凭证、拒绝模糊凭证、把错误映射到协议响应，并保证 `AuthenticatedCall` 不离开 Host 进程。
- **不包含授权和租户逻辑**：权限和 `TenantScope` 会消费认证身份，但它们仍是独立契约。
- **来源证明只在当前进程有效**：`AuthenticatedCall` 按设计不能经过序列化或进程重启；另一个进程必须重新验证自己的传输凭证。
- **不会自动启用**：加入构建图并不表示产品已经开启认证。
