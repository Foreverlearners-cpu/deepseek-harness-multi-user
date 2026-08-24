# @deepseek-ai/dsh-account

[English](README.md) | 中文

基于 [`ctx.users`](../user/README.md)、[`ctx.userCredentials`](../user-credential/README.md) 和 [`ctx.auth`](../auth/README.md) 的 Host-only 账号编排服务。它提供注册、密码登录后签发 JWT、刷新、全部会话登出、自助资料与密码修改，以及管理员账号操作。

本包不解析 HTTP、不计算密码哈希、不签名 JWT、不持久化记录，也不决定权限。可信传输层负责解析请求和限制秘密的生命周期；`dsh-user-credential` Provider 负责密码验证，JWT Provider 负责 JOSE 和 Token Family 生命周期。

## 组合方式

挂载 `dsh-user` 与 `dsh-user-credential` Provider、`dsh-auth`、`dsh-auth-password`、`dsh-auth-jwt` 以及本服务。`ctx.accounts` 仅供 Host 使用：传输层把稳定的 `AccountError.code` 映射为协议响应，且不得记录请求对象或返回的凭据值。

管理员方法接收由当前认证运行时签发的 `AuthenticatedCall`，并在修改前调用 `ctx.auth.assertCurrent()`。本包不实现 RBAC，因为账号服务不依赖 `dsh-authority`。可信调用方必须先授权 actor 执行目标管理员操作，再调用任何 `admin*` 方法。

## 账号流程

注册先创建用户，再以凭据 revision 0 添加规范化登录标识，以 revision 1 设置密码，最后请求 JWT Provider 签发凭据。添加标识失败时禁用新用户；设置密码失败时移除标识并禁用用户。`AccountError.recovery` 只报告用户 ID、已提交状态、凭据配置状态和补偿是否完成，不包含标识、密码、Verifier、Token 或 Provider 诊断信息。

登录通过 `ctx.auth` 路由密码证据，确认返回的 Call 仍然有效，要求用户仍处于 active 状态，然后委托 JWT 签发。刷新直接委托 JWT Provider；它的双重 JWT 校验同时验证 JOSE Claims 与持久化 Refresh Token Family。登出会撤销该认证用户的全部 JWT Family，因为通用认证接口中的 Access Credential 不公开 Family ID。

自助和管理员更新保留 `dsh-user` 与 `dsh-user-credential` 所有的乐观并发 revision。修改密码、管理员重置密码和禁用账号都会撤销全部 JWT Family。如果主要修改已经提交但撤销失败，错误码为 `session-revocation-incomplete`，恢复状态会标明已经提交的结果。

`account/changed` 事件包含操作类型、目标用户 ID、可选 actor 用户 ID、请求 ID 和时间。事件只在它代表的账号级操作完成后发出，且绝不包含秘密。

## 模型体验

### 账号生命周期

#### 模型看到什么

什么也看不到。`ctx.accounts` 让账号记录、认证证据、凭据和生命周期事件都只存在于 Host。

#### Token 影响

零。本包不注册 Prompt Section、Tool 或 Session Event。

#### KV Cache 影响

互不相关。账号编排不会改变模型可见的请求前缀。

## 已知限制与延期工作

- **授权由调用方负责** - 在 `dsh-authority` 与账号管理 Consumer 完成组合前，管理员方法要求可信 Consumer 预先授权。
- **登出覆盖全部会话** - 通用认证 Call 不携带 JWT Family ID，因此自助登出会撤销该用户的全部 Family。
- **没有分布式事务** - 用户和凭据 Provider 是独立服务；注册使用固定写入顺序、尽力补偿和显式恢复状态。
- **没有找回流程** - 邮箱验证、忘记密码挑战、锁定与账号找回需要专用策略和消息投递插件。
