# @deepseek-ai/dsh-user

[English](README.md) | 中文

与 Provider 无关的人类用户 Host 目录。该服务为每个账号提供稳定的 `UserId`，并回答该账号当前是否存在和可用。资料与生命周期操作负责维护这两个事实。

该包是 Service Definition，不创建表，也不保存密码、登录名、角色、租户成员关系、Token 或 Session。部署时挂载一个具体 Provider，例如后续的 `dsh-user-mysql`，作为 `ctx.users`。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.users.create(input)` | 创建 active 用户，由 Provider 生成稳定 id，初始 revision 为 1 |
| `ctx.users.get(userId)` | 返回当前记录，不存在时返回 `undefined` |
| `ctx.users.requireActive(userId)` | 返回 active 记录，并区分不存在、已禁用和已删除 |
| `ctx.users.update(request)` | 使用 `expectedRevision` 替换指定资料字段 |
| `ctx.users.disable(request)` | 将 active 用户转换为 `disabled` |
| `ctx.users.enable(request)` | 将 disabled 用户转换为 `active` |
| `ctx.users.delete(request)` | 软删除 active 或 disabled 用户；删除是终态 |
| `ctx.users.list(query)` | 按状态筛选并使用不透明 cursor 返回一页用户 |

核心职责仍然很小：创建或解析稳定的用户记录，以及判断该用户当前是否可用。管理、revision、分页和事件只是安全维护这些事实，不负责认证或授权调用者。

## 用户记录

`UserRecord` 包含 `userId`、可选 `displayName`、`status`、`createdAt`、`updatedAt`、`revision` 和 `extensions`。`userId` 由 Provider 生成，调用者不能选择。状态只有 `active`、`disabled` 和 `deleted`，`deleted` 之后不能再次转换。

`revision` 从 1 开始，每次资料或状态修改提交后严格增加 1。调用者把读取时的 revision 作为 `expectedRevision` 发送；发生并发修改时，过期操作以 `revision-conflict` 失败，而不会静默覆盖较新的数据。

`extensions` 是 JSON 对象，不是 JSON 编码字符串。顶层 key 必须带命名空间，值会深度分离并冻结，嵌套最多 16 层，编码后最多 16 KiB。Credential、角色、租户成员关系、生命周期状态、登录标识、Secret 和需要索引的业务字段不能放入 extensions。

## 实现 Provider

Provider 继承 `UserDirectory`，并把该子类作为唯一 `users` 服务挂载。它实现四个 protected 操作：创建记录、读取记录、原子修改记录和列出一页记录。基类负责校验、不可变分离结果、意外错误归一化，以及 Provider 成功提交后的 `user/changed` 事件。

`mutateRecord()` 接收资料修改或状态修改。Provider 原子比较 `expectedRevision`、提交新记录，并返回准确的 `previous` 和 `current` 记录。`user-not-found`、`status-conflict`、`revision-conflict` 等预期失败使用 `UserDirectoryError`；意外存储错误转换为 `provider-unavailable`。

`tests/contract.ts` 中的共享套件是 Provider 的规范测试。仓库内每个 Provider 都要导入 `runUserDirectoryContract()`，并把它绑定到全新的空存储介质。

## 管理员操作

是否可以管理其他用户由调用方判断，不由 `dsh-user` 判断。典型管理员修改按照以下顺序进行：

```text
transport credential
  -> dsh-auth establishes actorUserId
  -> dsh-auth-rbac requires user:update
  -> business service validates allowed fields
  -> ctx.users.update({ userId: targetUserId, patch, expectedRevision, context })
  -> Provider commits and user/changed carries actorUserId, reason, and correlationId
```

`actorUserId` 与目标 `userId` 是两个独立值。Operation context 是可信审计元数据，不是授权证明。重置密码调用密码 Credential Provider；用户禁用可以由 Session 或 Token 撤销插件消费，这两种操作都不属于普通资料更新。

## 事件

每次成功创建、资料修改和状态转换都会在 Provider 提交后发出 `user/changed`。不可变事件包含用户 id、已提交 revision、status、Provider 时间、修改类型，以及可选的操作者、关联 id 和原因。事件排除显示名、extensions、登录标识、Credential 和 Provider 诊断。

监听器失败会被隔离并记录，因此一个观察者不能回滚已经提交的用户，也不能阻止后续观察者。同步 invariant 失败会在所有监听器运行后继续抛出。该 live event 可用于审计、缓存失效和投影；持久化外部事件流仍需要 Provider 拥有的事务 outbox。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | 资料、extension、revision、上下文字段或列表范围无效 |
| `user-not-found` | 稳定用户 id 没有对应记录 |
| `user-disabled` | `requireActive()` 找到已禁用用户 |
| `user-deleted` | 用户已经终态删除，或不能执行请求的操作 |
| `status-conflict` | 当前状态不允许请求的生命周期转换 |
| `revision-conflict` | 调用者读取后记录已经发生变化 |
| `provider-unavailable` | Provider 意外失败或返回无效结果 |

传输适配器根据防止用户枚举的需要，决定哪些内部分类应折叠成同一种公开响应。

## 模型体验

### 用户目录状态

#### 模型看到什么

什么也看不到。用户记录、operation context 和 `user/changed` 事件只存在于 Host；该包不注册可能向模型暴露这些数据的 prompt section、工具或 Session event。

#### Token 影响

为零。用户目录操作不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。用户目录变化不会改变模型可见的请求前缀，因此不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **没有生产 Provider** - MySQL 包必须拥有 schema、migration、索引、事务、cursor 编码和数据库错误分类。
- **没有登录 Credential** - 用户名、邮箱、密码 verifier、API key、JWT 和 refresh-token 存储属于映射到 `UserId` 的认证 Provider 包。
- **没有授权或租户能力** - 管理权限和租户成员关系检查在调用该服务之前完成。
- **没有持久化审计投递** - `user/changed` 是进程内事件；持久化审计或集成事件流需要持久化 Provider 中的事务 outbox。
- **没有物理擦除工作流** - 软删除保留稳定引用；跨领域的合规擦除需要独立的协调工作流。
