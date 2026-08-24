# @deepseek-ai/dsh-auth-password

[English](README.md) | 中文

密码认证 Consumer 和 Provider 适配器。它向 [`ctx.auth`](../auth/README.md) 注册准确的 `password` evidence kind，通过 [`ctx.userCredentials`](../user-credential/README.md) 解析登录标识并验证候选密码，再返回已验证用户身份事实，由 `dsh-auth` 生成 `AuthenticatedCall`。

该包不解析 HTTP、不存储密码、不哈希 Secret、不签发 JWT、不检查权限，也不实现账号注册与找回。受信任传输层构造密码 evidence；具体的 `dsh-user-credential` Provider 拥有归一化、查询、verifier 存储、哈希和 dummy verification。

## 组合

挂载 `dsh-auth`、一个 `dsh-user-credential` Provider 和本插件。本插件要求 `ctx.auth` 与 `ctx.userCredentials`，并通过 `ctx.effect()` 安装 registry disposer：

```ts
import type { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, { authenticationRequestId } from '@deepseek-ai/dsh-auth'
import PasswordAuthentication from '@deepseek-ai/dsh-auth-password'

declare function installCredentialProvider(ctx: Context): Promise<void>

export async function authenticatePassword(ctx: Context): Promise<void> {
  await ctx.plugin(AuthenticationRuntime)
  await installCredentialProvider(ctx)
  await ctx.plugin(PasswordAuthentication)
  await ctx.auth.authenticate({
    requestId: authenticationRequestId('login-1'),
    channel: 'http',
    evidence: {
      kind: 'password',
      identifier: { kind: 'username', value: 'alice' },
      password: 'candidate-password',
    },
    signal: new AbortController().signal,
  })
}
```

传输层仍负责只接受一种 Credential carrier、执行速率限制，以及把安全的 `AuthenticationError` 类别映射为协议响应。传输层不得记录或保留 evidence 对象。

## 数据流

只有 `evidence.kind` 为 `password` 时，`ctx.auth.authenticate()` 才选择本 Provider。Provider 调用 `ctx.userCredentials.resolve(identifier)`，随后总会调用 `verifyPassword()`。解析失败时省略 `userId`，要求 Credential Provider 执行 dummy verifier。匹配成功后返回 `{ principal: { kind: 'user', id }, authenticatedAt }`；只有 `dsh-auth` 能把这些事实转换成当前有效的 `AuthenticatedCall`。

Registry 对每个 evidence kind 和每种认证 method 各只允许一个 Provider。第二个密码 Provider 或另一个声明 `password` method 的 Provider 会立即以 `provider-conflict` 失败；Provider 绝不会依次尝试。

## 失败与 Secret 处理

未知标识、错误密码、格式错误的登录 evidence 和预期 Credential 拒绝都变成相同 message、code 为 `unauthenticated` 的 `AuthenticationError`。Credential 存储或哈希故障变成 `authentication-unavailable`。两种 message 都是固定值，并丢弃 Provider cause、标识值、密码、SQL 和 verifier 诊断。

`auth/result` 事件由 `dsh-auth` 而非本包发出。它包含 password evidence kind、method、outcome 和安全类别，但不包含标识或密码。本包不返回 `credentialId`，因为密码不是一个持久公开的 Credential identity。

## 模型体验

### 密码认证

#### 模型看到什么

什么也看不到。`password` evidence、Credential 查询、验证结果和认证身份只存在于 Host。

#### Token 影响

为零。本插件不注册 prompt section、工具或 Session event。

#### KV Cache 影响

相互独立。密码认证不会改变模型可见的请求前缀，也不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **没有账号生命周期检查** - 后续 account Consumer 会在签发 Credential 或允许请求前组合用户状态策略。
- **没有暴力尝试策略** - 速率限制、锁定、challenge 升级和风险信号属于 gateway 与 policy 插件。
- **不签发 Token** - 密码认证成功后，由专用 lifecycle Provider 签发 JWT access 和 refresh Credential。
- **时序取决于 Credential Provider** - 本包保证调用 dummy path，但只有具体 Provider 能让真实与 dummy verifier 工作量相当。
