# @deepseek-ai/dsh-user-credential-mysql

[English](README.md) | 中文

[`dsh-user-credential`](../user-credential) 的 MySQL Service Provider。它通过共享的 [`dsh-mysql`](../../multi/mysql) 连接服务提供 `ctx.userCredentials`，并拥有标识归一化、全局标识唯一性、密码 verifier 派生与存储、Credential 事务和自己的 schema。

## 组合

在本插件之前挂载一个 `dsh-mysql` 服务，并且只挂载一个 `ctx.userCredentials` Provider。激活时创建或验证 `dsh_user_credential_schema`、`dsh_user_credentials` 和 `dsh_user_login_identifiers`。已有版本不兼容、带版本 schema 不完整或存在无版本同名数据表都会拒绝激活。

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: user-credentials
  package: '@deepseek-ai/dsh-user-credential-mysql'
```

Consumer 使用与 Provider 无关的 `ctx.userCredentials` API。标识值在唯一性检查或查询前会去除首尾空白、执行 Unicode NFKC 归一化，并使用与部署 locale 无关的英语规则转成小写。归一化后的 `(kind, value)` 在全局唯一；标识表使用 `utf8mb4_bin`，避免 MySQL 再隐式执行另一套大小写或重音归一化。

## 密码 Verifier

密码 version 1 使用 Node.js `crypto.scrypt`，参数为 `N=16384`、`r=8`、`p=1`、随机 16-byte salt 和 32-byte derived key。这些值和 verifier version 是持久格式的安全常量，不是部署调优项。修改它们需要新的 verifier version 和明确的升级策略。

原始密码只作为操作参数和 scrypt 输入存在。Schema 保存 version、有界参数、salt、derived key 和修改时间；元数据、事件、返回值和 Provider 诊断绝不包含这些字段。派生后使用 `timingSafeEqual` 验证。启动时创建带随机 salt 的进程内 dummy verifier；标识不存在、用户不存在和密码禁用时都会使用同样受支持的 scrypt 参数执行一次派生，再返回 `false`。

## 事务与失败

标识和密码状态共享一个 aggregate 行与 revision。每次修改用 `SELECT ... FOR UPDATE` 锁定 aggregate，验证 expected revision，应用标识或 verifier 状态，使用同一 revision 条件更新，重新读取元数据，然后提交。唯一 `(kind, normalized_value)` 索引在不同用户和进程之间串行化标识分配。只有本 Provider 返回已提交结果后，基础服务才发出脱敏事件。

预期内的重复标识、状态不存在、当前密码无效和 revision 冲突保留稳定的 `dsh-user-credential` 错误码。SQL、schema、异常 verifier、事务、加密和回滚失败由基础服务重建为 `provider-unavailable`，不保留 Provider 消息或 cause。

## Model Experience

### MySQL 用户 Credential

#### 模型看到什么

什么也看不到。该 Provider 仅在 Host 运行，提供 `ctx.userCredentials`，但不注册 tool、prompt、message 或 Session event。它只支持已有的进程内脱敏 Credential 事件。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

与模型请求无关：Credential 读取和修改不会改变请求前缀。

## 已知限制与延期工作

- **仅支持 schema 和 verifier version 1** - 数据库版本不兼容时拒绝激活，也不会在读取已有 verifier 时自动重新派生。
- **没有密码策略或恢复流程** - 密码强度、泄露密码检查、重置 challenge、邮箱验证、MFA、锁定和 rate limit 属于专用 Consumer 或 Provider。
- **没有 pepper 或外部 KMS** - version 1 依靠每密码 salt 和数据库访问控制；需要 pepper 的部署必须单独设计密钥生命周期和 verifier version。
- **提供相近工作量，但不证明网络时序一致** - 返回 false 的路径会用同样参数执行一次 scrypt，但数据库访问和调度仍可能不同；认证端点还必须使用通用响应和 rate limit。
- **不会自动响应账号生命周期** - 禁用或删除 `dsh-user` 记录不会删除 Credential 行；认证组合必须要求用户处于 active 状态。
- **没有 transactional outbox** - 脱敏变更事件是进程内事件并在 commit 后发生；持久审计投递需要后续持久化设计拥有的 outbox。
