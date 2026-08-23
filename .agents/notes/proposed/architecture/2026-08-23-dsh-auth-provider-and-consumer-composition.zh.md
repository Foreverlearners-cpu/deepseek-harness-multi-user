# Agent Note: dsh-auth Provider 与 Consumer 组合

Status: proposed

[English](2026-08-23-dsh-auth-provider-and-consumer-composition.md) | 中文

## 问题

拟议的 [`dsh-auth` service](2026-08-23-dsh-auth-identity-and-credential-lifecycle.md)把认证规则与 JWT、API key、transport、tenant 和 authorization 插件分开。只有当 Provider 作者和传输 Consumer 能组合该 Service，同时不重建身份对象、不解析对方凭据格式、不依赖插件加载顺序，也不增加隐式 anonymous fallback 时，这种拆分才有价值。

实现者需要一条统一的拟议集成路径，说明认证器如何注册、传输层如何提交 evidence、Host Consumer 如何检查 authenticated call，以及 Token 签发、租户派生与授权分别从哪里开始和结束。

## 提案

使用 `ctx.auth` 作为同进程认证的唯一入口。具体 Provider 插件通过 Cordis effect 注册类型化 evidence verification 和可选 credential-lifecycle capability。传输 Consumer 从 Host 持有的 carrier data 中提取唯一 credential，调用 `authenticate()`，再通过 Host 专属 invocation context 传递结果 call。受保护 Consumer 在消费身份或将其传给 tenant 与 authorization service 前立即调用 `assertCurrent()`。

### 注入认证 Provider

Provider 包依赖 `@deepseek-ai/dsh-auth`，在插件激活时校验自身配置，构造一个 Provider descriptor，并为一个 evidence kind 注册。下面是拟议 API 的说明性示例，不代表已交付源码：

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type { AuthenticationProvider } from '@deepseek-ai/dsh-auth'

const provider: AuthenticationProvider<'bearer'> = {
  async verify(attempt) {
    const claims = await verifier.verify(attempt.evidence.token, {
      audience: attempt.audience,
      signal: attempt.signal,
    })
    return {
      principal: { kind: 'user', id: userId(claims.subject) },
      method: authenticationMethod('jwt'),
      credentialId: credentialId(claims.tokenId),
      authenticatedAt: clock.now(),
      expiresAt: claims.expiresAt,
    }
  },
}

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.auth.providers.register('bearer', provider),
    'dsh-auth-jwt: bearer authentication Provider',
  )
}
```

Provider 返回已验证事实，永远不构造 `AuthenticatedCall`。它不注册角色、不选择 tenant，也不返回原始 claims。核心 Service 复制这些事实、签发 call，并记录签发它的 Provider registration。Disposer 移除该 registration；第二个活动 `bearer` registration 会失败，而不是替换第一个。

API-key Provider 使用相同模式注册到 `api-key`。它比较单向 verifier，返回 user 或 service-account principal，并可以注册 inspect 与 revoke lifecycle capability。它不会为了匹配 JWT 而实现 refresh。

### 选择唯一 Provider

传输层在调用 `dsh-auth` 前把 carrier syntax 映射到一个 evidence kind：

```text
Authorization: Bearer <value>  -> bearer
X-API-Key: <value>             -> api-key
trusted same-process entry     -> in-process
```

每个请求只允许一项已识别 credential。没有 credential 产生 `unauthenticated`；多项 credential 产生 ambiguous-credential refusal；一项 credential 选择其 evidence kind 唯一注册的 Provider。验证失败会结束请求，永远不会落入其他 Provider。

多个 JWT issuer 不会创建多个顶层 `bearer` Provider。`dsh-auth-jwt` 拥有 issuer registry，并只使用不可信 Token metadata 选择一个已配置 verifier。该 verifier 必须校验 signature、确切 issuer、目标 audience、time claim、token kind 和 credential state。未知 issuer、配置歧义或验证失败直接拒绝，不会尝试其他 issuer。

### 认证传输请求

`dsh-auth-gateway` 拥有 HTTP、WebSocket、SDK、ACP 和进程内 evidence 提取。对于 HTTP 请求，它先执行已有 Host 与 Origin 检查，拒绝多 credential source，再调用：

```ts ignore-check
const call = await ctx.auth.authenticate({
  requestId: authenticationRequestId(randomUUID()),
  channel: 'http',
  evidence: { kind: 'bearer', token },
  audience: configuredAudience,
  signal: requestSignal,
})
```

Call 保持在解析后的业务 payload 之外。Connection 与 Gateway 通过 Host 专属 request context 传递它。HTTP 把缺失、无效、过期或已撤销 credential 映射为通用 `401`；Provider 不可用映射为有界 service failure。WebSocket 在 upgrade 前完成认证。任何 carrier 都不返回原始 credential value、账号存在性、Provider diagnostics 或未验证 claims。

### 消费 authenticated call

依赖身份的 Host Consumer 在使用前立即检查 freshness：

```ts ignore-check
const call = ctx.auth.assertCurrent(requestContext.call)
```

返回的 call 证明当前进程为该请求认证了一个 principal。它不证明该 principal 可以执行某项操作或访问某个 tenant。需要租户数据的 Consumer 把 call 传给 `dsh-tenant-scope`；保护产品操作的 Consumer 把当前 call 以及所需 scope 或 resource identity 传给 `dsh-authority`。

业务插件不解析 Authorization header、cookie、JWT claims 或 API key，也不读取全局 `currentUser`。不依赖调用方身份的插件保持不变。只有操作需要 identity、tenant 或 authorization decision 时，resource owner 才接收显式 security context。

### 使用凭据生命周期操作

登录、刷新、设备管理和退出 Consumer 使用 `ctx.auth.credentials`；普通业务请求不使用。JWT 登录 Consumer 在上游登录或 OIDC exchange 成功后，请求已配置 JWT capability 签发 access 与 refresh pair。Refresh 把 refresh secret 交给同一 Provider，由它原子轮换。Logout 根据请求范围撤销单个 credential 或 token family。

```ts ignore-check
const pair = await ctx.auth.credentials.issue('jwt', issueRequest)
const rotated = await ctx.auth.credentials.refresh('jwt', refreshRequest)
await ctx.auth.credentials.revoke('jwt', revokeRequest)
```

具体操作只接受注册了对应 capability 的 Provider。API-key Provider 可以暴露 `inspect` 与 `revoke`，同时把 `refresh` 明确拒绝为 unsupported。Credential result 是 secret-bearing value，只能写入目标 response 或安全 store。

### 组合与失败规则

挂载 `dsh-auth-gateway` 的生产组合必须挂载其接受 credential method 所需的每个 Provider。缺少必需 registration 时，只要组合可以解析，就在组合期间失败。Server profile 不存在 anonymous 或 local fallback。本地 profile 可以显式挂载独立 loopback-only Provider，但 network-capable composition 会拒绝该 Provider。

P0 `dsh-auth` 本身不改变现有 transport 或业务行为。只增加 Provider 也不会让任何 route 进入已认证状态。首次运行时行为变化发生在 `dsh-auth-gateway` 消费该 Service 时；受保护产品行为还需要 `dsh-authority` 和相应 resource-owner 检查。

### Provider 与 Consumer 测试

Provider 测试使用真实 registration API，验证有效、无效、过期、已撤销、错误 audience 和 unavailable 结果，同时不记录 credential。Consumer 测试证明 Host/Origin 检查先于 credential 使用、歧义 credential 被拒绝、认证先于业务 payload 分发、call 永远不进入 wire argument，并且拒绝请求不会调用业务 handler。跨 package assembled test 属于首次激活认证的 Gateway 变更。

## 备选方案

**让 Gateway 直接调用 JWT 与 API-key 插件。** 否决，因为每种 transport 都会重复 Provider 选择、规范化身份、expiry、provenance、error 和 event 行为。

**通过替换 `ctx.auth` 注入 Provider。** 否决，因为 JWT 与 API-key 认证需要共存，而单个 Provider 不应拥有 Service 的 provenance 与生命周期规则。

**为一个 evidence kind 注册多个 Provider，并按顺序尝试。** 否决，因为插件顺序会变成安全 policy，失败耗时会产生差异，严格 Provider 失败后还可能进入更宽松 Provider。

**把原始 credential 传给业务插件。** 否决，因为这会把 secret handling 与 Token 格式依赖扩散到认证 owner 之外。

**把 authenticated call 放入 RPC JSON。** 否决，因为客户端可以构造或重放身份字段，并且进程私有 provenance proof 会丢失。

## 验收标准

- Provider 作者可以通过 effect 注册一个 evidence verifier，并且只增加其 credential kind 实现的 lifecycle capability。
- 传输 Consumer 提取唯一 credential、选择一个 evidence kind、在业务分发前完成认证，并在 wire DTO 之外传递结果 call。
- 重复 Provider owner、缺失必需 Provider、请求 credential 歧义、未知 issuer 和验证失败都会拒绝且不 fallback。
- Host Consumer 在依赖 identity 前使用 `assertCurrent()`，并把 tenant 与产品权限判断交给其 owning service。
- JWT issuer 选择永远不把未验证 `iss` 或 `kid` 当作已认证事实，验证失败后绝不尝试其他 issuer。
- Provider 与 Consumer 示例不包含角色、tenant、业务 permission、原始 claim 传播或全局 current-user 机制。
- 在可执行 package API 与 assembled test 确立文档名称和行为前，该集成说明保持 proposed。

## 风险

- 说明性 API 名称可能在核心包实现期间变化。只有示例匹配导出类型和真实组合后，该 note 才能移动到 implemented。
- 严格拒绝多项 credential 可能暴露当前发送冗余 header 的客户端。Gateway release note 和 client test 必须明确一项凭据规则。
- 每个 evidence kind 只有一个顶层 Provider，会把 multi-issuer 复杂度移入 L2 包。这些包需要确定性 issuer 与 key 选择、有界远程 key refresh 和显式配置冲突。
- 如果 bridge 先缓冲 body，再执行认证，那么业务分发前认证不能避免所有传输资源成本。Gateway 设计必须在 carrier 允许时把 credential 检查放在缓冲前，并记录剩余限制。
