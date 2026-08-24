# @deepseek-ai/dsh-auth-token

[English](README.md) | 中文

与 Provider 无关的 Host 不透明 refresh-token family 服务。它生成高熵 refresh secret，只把 SHA-256 digest 传给 Provider 持久化操作，并通过 `ctx.authTokens` 定义原子轮换、复用检测、检查和撤销。

该包不编码或验证 JWT，不签发 access token，不认证密码，不打开数据库，也不选择传输层 Cookie。JWT 或其他 Token Provider 把自身的 access-token 实现与这里的 refresh-family 状态组合起来。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.authTokens.issueFamily(request)` | 创建 active family，并且只返回一次首个 refresh secret |
| `ctx.authTokens.rotate(request)` | 原子消费一个 refresh secret，并返回替代 secret |
| `ctx.authTokens.inspect(request)` | 返回不包含 secret 或 digest 的安全 family 与 Credential 元数据 |
| `ctx.authTokens.revoke(request)` | 按 refresh Credential、token family 或 principal 撤销 |

每个操作携带 Host 生成的 `AuthenticationRequestId` 和 `AbortSignal`。`issueFamily` 接收已经认证的 `AuthenticatedPrincipal`；持有 refresh token 不会重新证明最初的登录身份。

## 状态与过期

Family 的 revision 从 1 开始，每次成功轮换或首次撤销后严格增加 1。对已撤销 family 的幂等撤销不会改变 revision。Revision 用于排序已提交的 family 变化，不是由调用者选择的乐观锁。

`TokenFamilyRecord.expiresAt` 是签发时确定的 family 绝对生命周期。每个替代 refresh Credential 必须在未来过期，并且不能晚于 family。轮换绝不会延长 family 生命周期。Provider 在同一事务中比较过期时间并消费当前 digest。

Refresh Credential 的状态为 `active`、`rotated` 或 `revoked`。成功轮换会原子地把已消费 Credential 改为 `rotated`、创建一个 `active` 替代项，并增加 family revision。同一个 secret 的两个并发轮换不能同时成功。

`rotate` 最多接受 4 KiB 的 UTF-8 refresh-token 输入。这个上限可以限制恶意散列和查询工作，同时不会约束本服务生成的 secret。

## 复用检测

提交属于 `rotated` Credential 的 digest 就是复用。Provider 以 `refresh-token-reuse` 原因原子撤销整个 active family；服务发出已提交的 `reuse-detected` 事件，然后以 `refresh-token-reused` 拒绝。此后使用该 family 的任何 Credential 都以 `token-family-revoked` 失败。

未知 Token 以 `refresh-token-invalid` 失败。过期 Token 以 `refresh-token-expired` 失败，不会轮换或撤销原本仍为 active 的 family。传输适配器可以在公开具体分类会帮助 Credential 探测时折叠这些错误。

## 实现 Provider

Provider 继承 `AuthTokenService`，实现 `createFamilyRecord`、`rotateFamilyRecord`、`inspectRecords` 和 `revokeRecords`。创建与轮换输入只包含 `RefreshTokenDigest`，绝不包含 refresh secret。持久记录必须保存 digest，并且不能记录、保留或返回 secret。

`rotateFamilyRecord` 在一个事务中锁定或条件更新匹配的 Credential 与 family。它返回经过验证的 `rotated` commit（含已消费记录与替代记录），或者返回含 family 撤销的 `reused` commit。`revokeRecords` 在一个事务中修改所有选中的 active family 及其 active Credential，并对已经撤销的 family 保持幂等。

Provider 结果必须绑定到请求目标。`inspectRecords` 只能返回由所请求 family、principal 或 Credential 选中的 family。按 Credential 撤销时，`revokeRecords` 必须返回 `matchedCredential`，作为所请求 Credential 属于唯一返回 family 的可验证证明；family 和 principal 目标不能返回该证明。

`tests/contract.ts` 中的共享套件是 Provider 规范测试。每个 Provider 把 `runAuthTokenContract()` 绑定到空存储实例，并补充后端专属的事务、持久性、digest 唯一索引和 migration 测试。

## 与 Access Token 组合

本包不签名 JWT。JWT Provider 必须先解析并验证可用的签名密钥，并在提交 `issueFamily` 或 `rotate` 前准备好所有可能失败的签名依赖。Refresh-family 提交后，access-token 序列化和签名必须是预期不会失败的内存操作。如果 Provider 无法保证这个边界，就必须在暴露签名失败前同步撤销刚提交的 family 作为补偿。

## 事件

`auth-token/changed` 只在签发、轮换、撤销或复用撤销提交后发出。它包含 request、family、principal、revision、status、time，以及可选的 Credential／reason 元数据。它绝不包含 refresh secret、digest、access token、JWT claim 或 Provider 诊断。

所有监听器失败（包括归类为 invariant 的失败）都会被记录并隔离，因此不能让已经提交的 API 调用失败，也不能阻止后续监听器。该事件只存在于进程内；持久审计投递需要持久化 Provider 在状态变化旁写入事务 outbox。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | Principal、request id、过期时间、signal 或 Provider 策略输入无效 |
| `operation-cancelled` | Provider 工作开始前操作已经取消 |
| `refresh-token-invalid` | 没有 Credential 匹配提交的 refresh secret |
| `refresh-token-expired` | Credential 或其绝对 family 生命周期已经过期 |
| `refresh-token-reused` | 已轮换 Credential 被复用，并已撤销其 family |
| `token-family-revoked` | 选中的 family 已经撤销 |
| `provider-unavailable` | Provider 意外失败或返回不一致 commit |

## 模型体验

### Refresh-token 状态

#### 模型看到什么

什么也看不到。`ctx.authTokens`、refresh secret、digest、family 记录和 `auth-token/changed` 都只存在于 Host；该包不注册 prompt、工具或 Session event。

#### Token 影响

为零。Token-family 操作不会改变模型输入。

#### KV Cache 影响

相互独立。Token-family 状态不会改变模型可见的请求前缀。

## 已知限制与延期工作

- **没有生产持久化 Provider** - MySQL 实现必须拥有 schema、事务、锁、digest 唯一索引、migration 和持久审计 outbox 行为。
- **没有 access-token 格式** - JWT 签名、claim、密钥轮换、audience 校验和 access-token 撤销策略属于 `dsh-auth-jwt` 或其他认证 Provider。
- **没有传输集成** - Cookie 属性、bearer 解析、CSRF 防护和公开错误折叠属于 HTTP 或 gateway Consumer。
- **不会自动级联用户禁用** - Consumer 必须响应权威用户生命周期变化，并撤销该 principal 的 family。
