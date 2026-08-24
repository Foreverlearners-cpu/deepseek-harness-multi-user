# @deepseek-ai/dsh-auth-jwt

[English](README.md) | 中文

该 JWT Authentication Provider 签发短生命周期 access JWT 和可轮换 refresh JWT。它在 `ctx.auth` 注册 `bearer` evidence 与 `jwt` Credential 生命周期方法，`ctx.authTokens` 则保留权威的服务端 refresh-family 状态。

## 配置

`issuer` 和 `audience` 是精确匹配的 JWT claim。`accessTtlSeconds` 默认 900，最大 3,600；`refreshTtlSeconds` 默认 2,592,000，最大 31,536,000，且不得短于 access 生命周期。`clockToleranceSeconds` 默认零，最大 300。

`keys` 包含一到十六个 HS256 key。每项具有受保护头使用的 `keyId`，以及编码 32-128 个随机字节的规范 base64url `secret`。`activeKeyId` 选择签名 key。验证接受所有已配置 key，因此部署轮换 key 时先添加新 key 并把它设为 active，保留旧 key 直到旧 Token 过期，然后再移除旧 key。

```yaml
- name: '@deepseek-ai/dsh-auth-jwt'
  config:
    issuer: https://auth.example.test
    audience: dsh-host
    activeKeyId: key-2026-08
    keys:
      - keyId: key-2026-08
        secret: BASE64URL_ENCODED_RANDOM_SECRET
```

## Credential 流程

另一个 Provider 证明身份后，调用 `ctx.auth.credentials.issue(authenticationMethod('jwt'), request)`。结果包含一个 `access` JWT 和一个 `refresh` JWT。可信传输层把 access 值作为 `{ kind: 'bearer', token }` 提交给 `ctx.auth.authenticate()`，并把 refresh 值提交给 `ctx.auth.credentials.refresh()`。

两个 JWT 都固定校验 `alg`、`kid`、`iss`、`aud`、`typ`、`iat`、`nbf`、`exp` 与 `jti`。`typ=access` 和 `typ=refresh` 不能互换。Access JWT 验证还会检查服务端 family；对于 user principal，还会调用 `ctx.users.requireActive()`。因此禁用或删除用户后，即使 access JWT 的密码学验证仍然有效，也会被拒绝。

Refresh JWT 携带 `ctx.authTokens` 生成的高熵不透明 refresh secret，以及 family 和 Credential id。持久化 Provider 只存储 secret digest。刷新先验证已签名的 `typ=refresh` 封装，再把内部 secret 交给 `ctx.authTokens.rotate()`。一次成功轮换会消费该值；重放旧 refresh JWT 会原子撤销 family，因此已签名 JWT 不能绕过服务端状态。

签发和刷新都会在变更 family 状态前解析 active 签名 key。两个 JWT 都通过 `ctx.authTokens` 的事务 preparation callback，在持久化 Provider 持有 mutation lock 时完成签名。只有两次签名都成功后才会提交 family 创建或轮换；签名或候选一致性检查失败时不会产生新 family，也不会消费旧 refresh Credential。

## 检查与撤销

`ctx.auth.credentials.inspect(authenticationMethod('jwt'), request)` 返回从 `ctx.authTokens` 投影的持久 refresh Credential 元数据。自包含 access JWT id 不会持久化，因此不会出现在检查结果中。撤销通过相同生命周期 runtime 接受 Credential、family 或 principal 目标；family 与 principal 撤销会立即使匹配的 access JWT 失效，因为每次 access 验证都会检查当前 family 状态。

## Model Experience

### 认证状态

#### 模型会看到什么

什么也看不到。`ctx.auth.authenticate()` 让 JWT、claim、key、family 状态和认证失败都仅属于 Host，不注册 prompt section、tool 或 session event。

#### Token 影响

零。认证不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。JWT 签发、验证、刷新和撤销不会改变模型可见的请求前缀。

## Known Limitations and Deferred Work

- **对称 key** - 该 Provider 固定使用 HS256，并要求每个验证方持有签名 secret；非对称签名或远程 KMS 签名需要另一种 JWT Provider 设计。
- **没有持久 access-token 索引** - 检查与定向撤销作用于 refresh Credential 和 family；access JWT 验证使用过期时间以及当前 family 与用户状态。
- **Host 侧 key 配置** - key 值由 Loader 配置提供；后续 starter 可以从 `ctx.credentials` 解析 secret reference，而不改变 JWT claim 或 family 语义。
