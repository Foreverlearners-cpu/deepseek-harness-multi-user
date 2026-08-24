# @deepseek-ai/dsh-auth-token-mysql

[English](README.md) | 中文

提供方无关的 [`dsh-auth-token`](../auth-token) refresh-token family 生命周期的 MySQL Service Provider。它通过共享的 [`dsh-mysql`](../../multi/mysql) 连接服务提供 `ctx.authTokens`，只保存 refresh token 的 SHA-256 digest，从不保存 bearer secret。

## 组合

先挂载一个 `dsh-mysql` 服务，再挂载本插件。激活时会取得 database 范围的 MySQL advisory lock，然后创建或验证 `dsh_auth_token_schema`、`dsh_auth_token_families` 和 `dsh_auth_refresh_credentials`，最后释放锁。无法取得锁、存在未记录版本的自有表、版本化 schema 不完整或版本不等于 `AUTH_TOKEN_MYSQL_SCHEMA_VERSION` 时，激活会失败。

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: authTokens
  package: '@deepseek-ai/dsh-auth-token-mysql'
```

消费方使用提供方无关的 API，不依赖本包：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { authenticationRequestId, userId } from '@deepseek-ai/dsh-auth'
import '@deepseek-ai/dsh-auth-token'

export async function beginSession(ctx: Context): Promise<string> {
  const issued = await ctx.authTokens.issueFamily({
    requestId: authenticationRequestId('login-request'),
    signal: new AbortController().signal,
    principal: { kind: 'user', id: userId('user-1') },
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1_000,
  })
  return issued.refreshToken.value
}
```

只能挂载一个 `ctx.authTokens` Provider。本包没有配置项，因为表名、索引、digest 算法和 schema identity 是持久格式与安全常量。

## 持久化与并发

`dsh_auth_token_families` 保存 principal identity、family 状态、过期时间、吊销原因和单调递增 revision。`dsh_auth_refresh_credentials` 保存唯一 SHA-256 digest、对应的生命周期 metadata 和 family 关系。检查结果由 `dsh-auth-token` 移除 digest；API 结果和事件都不会暴露 digest 或 bearer secret。

创建 family 时在一个事务中写入 family 与首个 credential。轮换先定位不可变的 family 关系，再依次锁定 family 和提交的 credential，只消费一次 active digest，并让 replacement 沿用已锁定 family 的绝对过期时间。并发或后续重用会锁定相同记录，在同一事务中吊销 family 及其所有 active credential，然后返回 `refresh-token-reused`。按 credential、family 或 principal 吊销时采用相同的锁顺序，并且操作具有幂等性。

检查操作在一个事务中持有 shared family lock 并读取选中的 family 与 credential，因此结果不会把并发修改前的 family metadata 和修改后的 credential 组合起来。按 credential 检查和吊销时，返回 base service 前会将结果绑定到请求指定的 credential。未知 credential 和 family 产生空的检查或吊销结果。使用持久数据前会验证每个 id、enum、digest、时间关系和特定状态专属的 nullable 字段。未知 refresh secret 返回 `refresh-token-invalid`；过期状态和 family 已吊销状态保留 `dsh-auth-token` 错误码。连接、SQL、异常数据库行、schema 和事务故障统一变成 `provider-unavailable`，不会暴露 SQL、digest、bearer secret 或 driver diagnostics。

## 模型体验

### MySQL refresh-token 状态

#### 模型看到什么

什么也看不到。该 Provider 仅在 Host 中运行，不注册工具、prompt、消息或 Session event。此 Provider 提交后，`dsh-auth-token` 发出已有的脱敏进程内生命周期事件。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

数据库操作不会改变模型请求前缀。

## 已知限制和延后工作

- **仅支持 schema version 1** - 不兼容版本或未记录版本的自有表会导致激活失败；本插件不尝试 migration。
- **SHA-256 依赖生成的高熵 secret** - 本 Provider 不是 password store，只能接收由 `dsh-auth-token` 生成的 refresh secret。
- **没有 transactional outbox** - 生命周期事件仍是提交后发出的进程内事件；持久 audit 投递需要独立拥有的 outbox。
- **单 database binding** - 本 Provider 使用唯一注入的 `ctx.mysql` 服务，不按 request 或 tenant 选择数据库。
