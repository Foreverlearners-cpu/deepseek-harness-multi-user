# @deepseek-ai/dsh-account-mysql

[English](README.md) | 中文

这是 [`dsh-account`](../account) 所定义持久注册操作接口的 MySQL Service Provider。它使用共享的 [`dsh-mysql`](../../multi/mysql) 连接服务，只保存非秘密的注册进度、恢复状态和完成后的 `UserRecord`。它不会保存登录标识、密码、密码 verifier、access token、refresh token 或 token digest。

## 组合

先挂载 `dsh-mysql` 和 `dsh-account`，再挂载本插件。激活时会取得 database 范围的 advisory lock，创建或验证 `dsh_account_schema` 与 `dsh_account_registration_operations`，释放锁，然后注册唯一的 `ctx.accounts.registrationOperations` Provider。无法取得锁、存在未记录版本的自有表、版本化表缺失或版本不等于 `ACCOUNT_MYSQL_SCHEMA_VERSION` 时，激活会失败。

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: account
  package: '@deepseek-ai/dsh-account'
- name: accountOperations
  package: '@deepseek-ai/dsh-account-mysql'
```

账号消费方继续调用 `ctx.accounts.register(...)`，不导入本包。只能挂载一个注册操作 Provider。本包没有配置项，因为表名、索引、schema identity 和持久化字段都是持久格式常量。

## 幂等与并发

`requestId` 是唯一的注册幂等键。`begin(requestId)` 会原子创建 revision 为 `1`、stage 为 `begun` 的记录，或者返回已有操作。调用方必须为每笔逻辑上全新的注册创建新 `requestId`，只能在重试同一笔注册时复用该键。Provider 刻意不保存或比较密码、标识、资料输入或输入 fingerprint。操作进入 `completed` 后，每次重试都返回不可变的已存 `UserRecord`，即使不可信 transport 提交了不同的重试字段；transport 必须防止意外复用键。

每次 stage 转换都会锁行，并同时比较 revision 和 stage。唯一的前进路径是 `begun` 到 `user-created`、`identifier-added`、`password-set`，最后到 `completed`；任意非终态 stage 都可携带完整的非秘密 recovery record 进入 `failed`。revision 过期、stage 已变化、用户关系变化、转换无效或第二次完成都会返回 `conflict`，且不修改记录。完成操作在同一个事务中写入 `UserRecord` 的全部字段，永远不会更新已完成结果。

只有所有 id、enum、正 revision、布尔标志、nullable 字段组、时间顺序、用户关系和带命名空间的 JSON extensions 能组成有效 `RegistrationOperationRecord` 时，持久行才会被接受。连接、SQL、异常行、schema 和 rollback 故障统一返回 `unavailable`，且不保留 driver diagnostics。本 Provider 不会把用户目录写入与 credential 写入合并为一个 MySQL 事务；分阶段 saga 与补偿行为由 `dsh-account` 持有。

## 模型体验

### MySQL 注册进度

#### 模型看到什么

什么也看不到。该 Provider 只在 Host 中运行，不注册工具、prompt、消息或 Session event。账号事件仍由 `dsh-account` 在编排提交后发出已有的脱敏进程内事件。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

数据库操作不会改变模型请求前缀。

## 已知限制和延后工作

- **仅支持 schema version 1** - 不兼容版本或未记录版本的自有表会导致激活失败；本插件不尝试 migration。
- **调用方持有 request id** - Provider 无法识别一笔逻辑上不同的注册复用了已完成 request id，因为提供方无关的接口只传入该 id。
- **没有 transactional outbox** - 账号事件仍是提交后的进程内事件；持久 audit 投递需要独立拥有的 outbox。
- **单 database binding** - Provider 使用唯一注入的 `ctx.mysql` 服务，不按 request 或 tenant 选择 database。
