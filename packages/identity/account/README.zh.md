# @deepseek-ai/dsh-account

[English](README.md) | 中文

基于 [`ctx.users`](../user/README.md)、[`ctx.userCredentials`](../user-credential/README.md) 和 [`ctx.auth`](../auth/README.md) 的 Host-only 账号编排服务。它提供持久化注册、密码登录后签发 JWT、刷新、全部会话登出、自助资料与密码修改，以及独立授权的管理员账号操作。

本包不解析 HTTP、不计算密码哈希、不签名 JWT、不持久化记录，也不决定权限。可信传输层负责解析请求和限制秘密的生命周期；`dsh-user-credential` Provider 负责密码验证，JWT Provider 负责 JOSE 和 Token Family 生命周期。

## 组合方式

挂载 `dsh-user` 与 `dsh-user-credential` Provider、`dsh-auth`、`dsh-auth-password`、`dsh-auth-jwt` 以及本服务。`ctx.accounts` 仅供 Host 使用：传输层把稳定的 `AccountError.code` 映射为协议响应，且不得记录请求对象或返回的凭据值。

注册写入前必须注入唯一的持久化 `RegistrationOperationProvider`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RegistrationOperationProvider } from '@deepseek-ai/dsh-account'

function installRegistrationOperations(ctx: Context, provider: RegistrationOperationProvider): () => void {
  return ctx.accounts.registrationOperations.register(provider)
}
```

Provider 负责 request id 的唯一性与状态持久化。`begin(requestId)` 必须原子创建 `begun` 记录，或返回已存在的记录；`advance(request)` 在确认预期 stage 与 revision 后记录进度；`complete(requestId, expectedRevision, user)` 原子保存不含秘密的 `UserRecord`；`read(requestId)` 向恢复工具公开持久化状态。未注入 Provider 时默认以 `unavailable` 失败，第二个 Provider 会被拒绝。Provider 插件卸载时应调用注册函数返回的 disposer。

管理员方法只存在于 `ctx.accountAdministration`。通过 `ctx.accountAdministration.authorizers.register(authorizer)` 注入唯一的 `AccountAdminAuthorizer`。每个方法先要求准确且当前有效的 `AuthenticatedCall`，再让 authorizer 检查明确的 action 与 target。authorizer 缺失、拒绝或抛错都会默认以 `forbidden` 失败；本包本身不实现 RBAC 策略。

## 账号流程

`ctx.accounts.register()` 会校验 request id、规范化登录标识、创建用户、添加标识并设置密码，并在每个已提交阶段后推进持久化操作。重试会从持久化 stage 继续，在 Provider 结果不明确时核对用户与凭据的实际状态，完成后始终返回已保存的同一个 `UserRecord`。注册不会签发 JWT；调用方需要另外调用 `login()`。这样无需把 Access 或 Refresh Secret 保存为幂等结果，也不会在重试时重放它们。

注册无法继续时，补偿流程会尽可能禁用新用户并移除已配置凭据。持久化的 failed stage 与 `AccountError.recovery` 只报告用户 ID、已提交状态、凭据配置状态和补偿是否完成，不包含标识、密码、Verifier、Token 或 Provider 诊断信息。持久化进度可以跨进程崩溃恢复，但不会在用户 Provider 与凭据 Provider 之间形成分布式事务。

登录会先解析规范化标识并读取凭据 revision，再通过 `ctx.auth` 路由密码证据。它确认返回的 Call 当前有效且指向解析出的用户，要求用户仍处于 active 状态，然后委托 JWT 签发。签发后会再次读取凭据记录；若用户、revision 或密码启用状态在签发期间发生变化，或二次读取失败，服务会撤销刚签发的 JWT 并拒绝登录。这个 credential revision fence 可防止并发修改密码或管理员重置密码后仍留下刚签发的会话。刷新直接委托 JWT Provider；它的双重 JWT 校验同时验证 JOSE Claims 与持久化 Refresh Token Family。登出会撤销该认证用户的全部 JWT Family，因为通用认证接口中的 Access Credential 不公开 Family ID。

自助资料更新只能修改 `displayName`；extensions 修改仍是管理员能力。自助和管理员更新保留 `dsh-user` 与 `dsh-user-credential` 所有的乐观并发 revision。修改密码、管理员重置密码和禁用账号都会撤销全部 JWT Family。如果主要修改已经提交但撤销失败，错误码为 `session-revocation-incomplete`，恢复状态会标明已经提交的结果。

`account/changed` 事件包含操作类型、目标用户 ID、可选 actor 用户 ID、请求 ID 和时间。事件只在它代表的账号级操作完成后发出，且绝不包含秘密。

## 模型体验

### 账号生命周期

#### 模型看到什么

什么也看不到。`ctx.accounts` 与 `ctx.accountAdministration` 让账号记录、认证证据、凭据、授权决策和生命周期事件都只存在于 Host。

#### Token 影响

零。本包不注册 Prompt Section、Tool 或 Session Event。

#### KV Cache 影响

互不相关。账号编排不会改变模型可见的请求前缀。

## 已知限制与延期工作

- **授权策略位于外部** - 本包要求唯一的 `AccountAdminAuthorizer`，但具体策略必须由 RBAC 集成等策略插件实现。
- **登出覆盖全部会话** - 通用认证 Call 不携带 JWT Family ID，因此自助登出会撤销该用户的全部 Family。
- **没有分布式事务** - 用户、凭据和注册操作 Provider 是独立服务；注册使用持久化分阶段进度、状态核对、尽力补偿和显式恢复状态。
- **没有找回流程** - 邮箱验证、忘记密码挑战、锁定与账号找回需要专用策略和消息投递插件。
