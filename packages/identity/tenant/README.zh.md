# @deepseek-ai/dsh-tenant

[English](README.md) | 中文

与 Provider 无关的租户及其用户成员关系 Host 目录。该服务为每个租户提供稳定的 `TenantId`，记录某个 `UserId` 当前是否属于该租户，并回答该成员关系是否可用。

该包是 Service Definition，不创建表，也不保存角色、团队、ACL、Token 或 Session。部署时挂载一个具体 Provider 作为 `ctx.tenants`。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.tenants.create(input)` | 创建 active 租户，由 Provider 生成稳定 id，初始 revision 为 1 |
| `ctx.tenants.get(tenantId)` | 返回当前租户记录，不存在时返回 `undefined` |
| `ctx.tenants.requireActive(tenantId)` | 返回 active 租户，并区分不存在、已禁用和已删除 |
| `ctx.tenants.disable(request)` | 将 active 租户转换为 `disabled` |
| `ctx.tenants.enable(request)` | 将 disabled 租户转换为 `active` |
| `ctx.tenants.delete(request)` | 软删除 active 或 disabled 租户；删除是终态 |
| `ctx.tenants.addMember(request)` | 将 `UserId` 加入 active 租户；已 removed 的配对可以用新的 membership id 重新加入 |
| `ctx.tenants.getMembership(tenantId, userId)` | 返回当前成员槽位，不存在时返回 `undefined` |
| `ctx.tenants.requireActiveMembership(tenantId, userId)` | 要求租户和成员关系都处于 active |
| `ctx.tenants.disableMembership(request)` | 将 active 成员关系转换为 `disabled` |
| `ctx.tenants.enableMembership(request)` | 将 disabled 成员关系转换为 `active` |
| `ctx.tenants.removeMembership(request)` | 软移除 active 或 disabled 成员关系；对该 membership id 而言移除是终态 |
| `ctx.tenants.listMembers(query)` | 按状态筛选并返回一个租户的一页成员关系 |
| `ctx.tenants.listUserMemberships(query)` | 按状态筛选并返回一个用户的一页成员关系 |

核心职责仍然很小：创建或解析稳定的租户，以及判断用户当前是否在该租户中拥有可用成员关系。管理、revision、分页和事件只是安全维护这些事实，不负责认证或授权调用者。

## 租户与成员记录

`TenantRecord` 包含 `tenantId`、可选 `displayName`、`status`、`createdAt`、`updatedAt` 和 `revision`。`tenantId` 由 Provider 生成，调用者不能选择。租户状态只有 `active`、`disabled` 和 `deleted`，`deleted` 之后不能再次转换。

`MembershipRecord` 包含 `membershipId`、`tenantId`、`userId`、`status`、`createdAt`、`updatedAt` 和 `revision`。`membershipId` 由 Provider 生成。成员状态只有 `active`、`disabled` 和 `removed`，`removed` 之后不能再次转换。每个 `(tenantId, userId)` 只有一个当前槽位。若该用户已有 active 或 disabled 成员关系，再次加入会以 `membership-conflict` 失败。在 `removed` 之后重新加入会创建新的 `MembershipId`，revision 从 1 开始。

`revision` 从 1 开始，每次状态修改提交后严格增加 1。调用者把读取时的 revision 作为 `expectedRevision` 发送；发生并发修改时，过期操作以 `revision-conflict` 失败，而不会静默覆盖较新的数据。

角色、团队、对象授权、Credential 和会话拥有的租户 id 不能放入这些记录。`requireActiveMembership` 只检查本目录，不调用 `ctx.users`。

## 实现 Provider

Provider 继承 `TenantDirectory`，并把该子类作为唯一 `tenants` 服务挂载。它实现七个 protected 操作：创建和读取租户、原子修改租户、创建和读取成员关系、原子修改成员关系，以及列出一页成员关系。基类负责校验、不可变分离结果、意外错误归一化，以及 Provider 成功提交后的事件。

`mutateTenantRecord()` 和 `mutateMembershipRecord()` 原子比较 `expectedRevision`、提交新记录，并返回准确的 `previous` 和 `current` 记录。`tenant-not-found`、`membership-conflict`、`status-conflict`、`revision-conflict` 等预期失败使用 `TenantDirectoryError`；意外存储错误转换为 `provider-unavailable`。

`tests/contract.ts` 中的共享套件是 Provider 的规范测试。仓库内每个 Provider 都要导入 `runTenantDirectoryContract()`，并把它绑定到全新的空存储介质。

## 管理员操作

是否可以管理租户或成员关系由调用方判断，不由 `dsh-tenant` 判断。典型管理员加入按照以下顺序进行：

```text
transport credential
  -> dsh-auth establishes actorUserId
  -> later authorization requires tenant:member.add
  -> ctx.tenants.addMember({ tenantId, userId, context })
  -> Provider commits and tenant/membership-changed carries actorUserId, reason, and correlationId
```

`actorUserId` 与目标 `userId` 是两个独立值。Operation context 是可信审计元数据，不是授权证明。

## 事件

每次成功创建租户或转换租户状态都会在 Provider 提交后发出 `tenant/changed`。每次成功创建成员关系或转换成员状态都会发出 `tenant/membership-changed`。不可变事件包含 id、已提交 revision、status、Provider 时间、修改类型，以及可选的操作者、关联 id 和原因。事件排除显示名、角色、Credential 和 Provider 诊断。

监听器失败会被隔离并记录，因此一个观察者不能回滚已经提交的记录，也不能阻止后续观察者。同步 invariant 失败会在所有监听器运行后继续抛出。这些 live event 可用于审计、缓存失效和投影；持久化外部事件流仍需要 Provider 拥有的事务 outbox。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | 显示名、revision、上下文字段、成员状态筛选或列表范围无效 |
| `tenant-not-found` | 稳定租户 id 没有对应记录 |
| `tenant-disabled` | `requireActive()` 或 `addMember()` 找到已禁用租户；`requireActiveMembership()` 在检查成员状态之前报告此错误 |
| `tenant-deleted` | 租户已经终态删除，或不能执行请求的租户操作 |
| `membership-not-found` | 租户处于 active，且 `(tenantId, userId)` 没有成员关系 |
| `membership-disabled` | `requireActiveMembership()` 在 active 租户上找到已禁用成员关系 |
| `membership-removed` | 成员关系已经终态移除，或不能执行请求的成员操作 |
| `membership-conflict` | 该配对已经存在 active 或 disabled 成员关系 |
| `status-conflict` | 当前状态不允许请求的生命周期转换 |
| `revision-conflict` | 调用者读取后记录已经发生变化 |
| `provider-unavailable` | Provider 意外失败或返回无效结果 |

传输适配器根据防止租户或成员枚举的需要，决定哪些内部分类应折叠成同一种公开响应。

## 模型体验

### 租户目录状态

#### 模型看到什么

什么也看不到。租户记录、成员关系、operation context 和 `tenant/changed` 事件只存在于 Host；该包不注册可能向模型暴露这些数据的 prompt section、工具或 Session event。

#### Token 影响

为零。租户目录操作不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。租户目录变化不会改变模型可见的请求前缀，因此不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **MySQL 持久化是独立的包** - [`dsh-tenant-mysql`](../tenant-mysql/README.md) 拥有 schema、索引、事务、cursor 编码和数据库错误分类。
- **没有团队或角色** - 团队记录和角色绑定属于后续的 `dsh-team` 和 `dsh-auth-rbac` 包。
- **没有授权** - 调用者是否可以创建租户或修改成员关系，在调用该服务之前决定。
- **没有用户目录查询** - 该服务接受品牌化 `UserId`，不要求也不调用 `ctx.users`。
- **没有持久化审计投递** - `tenant/changed` 和 `tenant/membership-changed` 是进程内事件；持久化审计或集成事件流需要持久化 Provider 中的事务 outbox。
- **没有物理擦除工作流** - 软删除和移除保留稳定引用；跨领域的合规擦除需要独立的协调工作流。
