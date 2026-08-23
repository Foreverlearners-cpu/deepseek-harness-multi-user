# @deepseek-ai/dsh-user-credential

[English](README.md) | 中文

与 Provider 无关的 Host 登录标识与密码 Credential 服务，并将它们映射到 [`UserId`](../user/README.md)。它维护人类用户如何登录；[`dsh-user`](../user) 继续拥有资料和账号生命周期状态。

该包是 Service Definition，不创建表，也不实现密码哈希算法。部署时挂载一个具体 Provider 作为 `ctx.userCredentials`；Provider 拥有标识归一化与唯一性、密码 verifier 存储、哈希参数、固定工作量 dummy verification、事务和持久化数据。

## 公共 API

| API | 用途 |
|---|---|
| `normalize(input)` | 使用可扩展 `kind` 对应的规则规范化一个原始标识 |
| `addIdentifier(request)` | 使用 `expectedRevision` 添加全局唯一的规范化标识 |
| `removeIdentifier(request)` | 使用 `expectedRevision` 删除一个规范化标识 |
| `resolve(input)` | 把原始标识解析为 `UserId`，不存在时返回 `undefined` |
| `get(userId)` / `list(userId)` | 返回分离的标识和密码状态元数据，不存在时返回 `undefined` |
| `setPassword(request)` | 设置或由管理员替换密码 |
| `changePassword(request)` | 验证当前密码并原子替换 |
| `verifyPassword(request)` | 对用户和密码只返回 `true` 或 `false` |
| `disablePassword(request)` | 禁用密码登录并移除有效 verifier 状态 |

`username`、`email` 和后续标识种类共享同一 API。当前 Provider 定义每种已支持 kind 的归一化规则，并明确拒绝不支持的 kind。调用方只用 `normalize()` 做预览和校验；添加、删除和解析会在执行唯一性约束或查询的操作中再次归一化。

## Credential 元数据与 revision

`UserCredentialRecord` 包含 `userId`、聚合 revision、规范化标识元数据、`passwordEnabled` 和时间戳，不包含任何密码材料。一个用户最多列出 32 个标识。原始值和规范化值最多 320 UTF-8 字节；密码进入 Provider 前最多 1024 UTF-8 字节。

Revision 0 表示 Credential 聚合尚不存在。第一个标识或密码操作与 0 比较并提交 revision 1。之后每次标识或密码修改都原子比较 `expectedRevision`，并把 revision 增加 1。共享 revision 防止并发的密码与标识管理静默覆盖彼此。

基类校验并冻结返回的元数据，也校验 Provider 提供的修改前后提交证明。受信任的 `get`、`list` 和 `resolve` 结果包含标识值，因为账号管理需要查看它们；变更事件、密码结果和该包返回的 Provider 诊断绝不包含这些值。

## 实现 Provider

Provider 继承 `UserCredentialService`，实现五个 protected 操作：规范化标识、读取元数据、解析规范化标识、原子修改 Credential 和验证密码。`mutateCredentialRecord()` 只在密码修改中接收 Secret，并且只返回元数据。Hash、salt、pepper 引用、verifier 版本和 dummy hash 始终属于 Provider 私有状态。

`verifyPasswordSecret()` 对未知用户、没有密码的用户和错误密码执行可比的密码 verifier 工作。公开 `verifyPassword()` 对这三种情况都返回 `false`，因此调用方不能从结果枚举账号或密码状态。Provider 意外故障仍转换为 `provider-unavailable`；传输层还应使用通用提示和速率限制。

可预期的存储失败使用 `UserCredentialError`：`identifier-conflict`、`identifier-not-found`、`password-not-set`、`invalid-credential` 和 `revision-conflict`。`tests/contract.ts` 中的共享套件是 Provider 规范测试，每个实现都必须运行它。

## 授权与账号生命周期

该服务不判断调用方是否可以重置密码或修改其他用户的标识。自助与管理员 Consumer 先认证操作者、要求相应 RBAC 权限、通过 `ctx.users` 要求目标用户处于 active 状态，然后携带目标 `userId`、预期 revision 和可选审计上下文调用 `ctx.userCredentials`。

在 `dsh-user` 中禁用或删除用户不会隐式修改 Credential 存储。认证组合在签发 authenticated call 前检查账号生命周期；专用 Consumer 可以按部署策略消费 `user/changed`，撤销 Session 或禁用登录方式。

## 事件

每次成功修改都在提交后发出 `user-credential/changed`。事件包含修改类型、`userId`、revision、Provider 时间，以及可选操作者、关联 id 和原因。它排除标识 kind 和 value、密码、verifier 材料和存储诊断。监听器失败不能回滚已经提交的 Credential 数据；同步 invariant 失败会在所有监听器运行后继续抛出。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | 标识语法或大小、密码大小、revision、id 或审计上下文无效 |
| `credential-not-found` | 需要聚合的元数据读取或修改操作找不到聚合 |
| `identifier-conflict` | 规范化 `(kind, value)` 已属于某个用户 |
| `identifier-not-found` | 目标用户没有请求的规范化标识 |
| `password-not-set` | 请求修改时密码登录未启用 |
| `invalid-credential` | `changePassword()` 未能验证当前密码 |
| `revision-conflict` | 调用方读取后 Credential 元数据已变化 |
| `provider-unavailable` | Provider 意外失败或返回无效元数据 |

登录传输层把标识不存在和密码失败折叠成相同的公开认证响应。`resolve()` 供受信任的认证与管理 Consumer 使用，不能直接作为未认证的账号发现端点。

## 模型体验

### 用户 Credential 状态

#### 模型看到什么

什么也看不到。`ctx.userCredentials` 的标识、密码操作、元数据和事件只存在于 Host；该包不注册 prompt section、工具或 Session event。

#### Token 影响

为零。Credential 操作不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。Credential 变化不会改变模型可见的请求前缀，也不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **没有生产 Provider** - 持久化包必须选择归一化规则、哈希库与参数、schema、migration、索引、事务、dummy verifier 和数据库错误分类。
- **没有注册或恢复流程** - 邮箱验证、密码策略、重置 challenge、锁定、MFA 和产品路由属于专用 Consumer 与 Provider。
- **没有自动生命周期联动** - 用户禁用、删除和 Session 撤销需要显式组合 `dsh-user`、认证与 Token/Session 插件。
- **没有持久化审计投递** - live change event 只存在于进程内；需要外部投递时，持久化 Provider 拥有事务 outbox。
