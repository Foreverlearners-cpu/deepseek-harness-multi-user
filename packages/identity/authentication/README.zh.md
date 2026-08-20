# @deepseek-ai/dsh-authentication

[English](README.md) | 中文

经过验证且不可变的 Host 调用身份 Service Definition。传输适配器提交由 carrier 拥有的证据，当前的 `AuthenticationProvider` 对其进行验证，服务再签发下游授权可以信任的 `AuthenticatedCall`。身份通过 Host 代码显式传递，绝不会从 RPC JSON payload 中取得。

## API

- `AuthenticationProvider` 提供 `authenticate(attempt)`，并将 carrier 验证交给其受保护的 `verify(attempt)` 实现。只有此服务可以签发被接受的调用。
- `authenticationRequestId()`、`userId()`、`serviceAccountId()`、`localPrincipalId()`、`tenantId()`、`membershipId()`、`operatorGrantId()` 和 `authenticationMethod()` 这些 branding helper 会在稳定标识符进入调用上下文前完成校验。
- `AuthenticatedCall`、`AuthenticationAttempt`、`VerifiedAuthentication`、principal 类型、scope 类型和 carrier evidence 类型均由本包及其 `./types` 入口导出。
- `isAuthenticatedCall()` 执行运行时签发者校验；`AuthenticationError` 携带可安全返回给 carrier 的 `unauthenticated` 或 `authentication-unavailable` 类别。

## 身份认证契约

一次 attempt 包含由 Host 生成的请求 id、channel、由 carrier 拥有的证据以及请求取消 signal。当前证据映射包含由 Host 保留的 HTTP `Request` 值和显式的同进程 `in-process` carrier。Provider 返回 principal、身份认证方式、tenant 或 platform scope，以及可选的过期时间戳。服务会复制并冻结 Provider 拥有的身份数据，将调用绑定到 attempt 元数据，并把这个确切对象记录到私有签发者集合中。

签发者集合是运行时的权威。结构复制、JSON 往返、客户端 payload 或拥有相同字段的对象都不是已认证调用。这样可以让身份认证证据留在 Host 一侧，同时允许授权和领域代码接收显式的不可变值。

## 失败语义

- 无效的 branded 标识符会在 Provider 签发调用前抛出 `TypeError`。
- Provider 验证错误会原样传出，并且不会签发调用。
- Provider 返回非有限 `expiresAt` 时，会转为带有 `authentication-unavailable` 的 `AuthenticationError`。
- 过期时间会保留在调用中；授权层负责在评估权限前拒绝已过期调用。

## 组合

本包是 Service Definition，不是登录页面或凭证数据库。具体 Provider 必须显式挂载到 Host context。传输适配器应在仍持有原始 carrier 请求时调用 `authenticate()`，之后只把得到的调用传入受保护的应用代码。`./invariant` 导出不变式伴生插件；与仓库的不变式服务组合时，它会检查本包拥有的运行时关系。

对于 Connection Host 适配器，这也覆盖 legacy API 面：在解析 unary 或 `/api/respond` body、打开 session 导出或 SSE source 之前，以及事件流 WebSocket upgrade 期间，都会使用原始 `Request` 完成认证。得到的调用始终通过带外参数传递；路由权限和领域资源检查会分别消费它。

## 模型体验

无，因为 principal id、membership id、scope 和 carrier evidence 始终是 Host 侧授权输入，绝不会进入模型请求。

#### KV Cache 影响

无；身份认证元数据不会被组装进模型请求前缀。

## 已知限制与暂缓工作

- **Provider 自行负责验证** —— 本包不会解析 OIDC token、session、API key 或远程身份存储；这些属于具体 Provider 与传输适配器。
- **没有内置撤销存储** —— 可选的过期时间会复制进调用，撤销与策略变化由身份认证或授权 Provider 负责。
- **必须显式组合** —— 基础服务没有匿名 fallback，不应在没有明确身份认证策略时挂载。
- **Carrier 映射刻意保持狭窄** —— 增加新的传输需要扩展类型化的 `AuthenticationEvidenceMap`，并由 Host 适配器确保该证据不进入业务 payload。
- **身份认证只是第一道门** —— 有效调用不会自动授权操作，也不会过滤返回资源。路由适配器与领域方法仍必须执行权限和资源级策略。
