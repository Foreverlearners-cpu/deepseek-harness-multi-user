# @deepseek-ai/dsh-team

[English](README.md) | 中文

与 Provider 无关的团队及其用户成员关系 Host 目录。该服务为每个团队提供稳定的 `TeamId`，并把它绑定到恰好一个 `TenantId`，记录某个 `UserId` 当前是否属于该团队，并回答该用户在一个租户内拥有哪些团队。

该包是 Service Definition，不创建表，也不保存角色、ACL 授权、Token 或 Session。部署时挂载一个具体 Provider 作为 `ctx.teams`。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.teams.create(input)` | 在一个租户下创建 active 团队，由 Provider 生成稳定 id，初始 revision 为 1 |
| `ctx.teams.get(teamId)` | 返回当前团队记录，不存在时返回 `undefined` |
| `ctx.teams.requireActive(teamId)` | 返回 active 团队，并区分不存在、已禁用和已删除 |
| `ctx.teams.disable(request)` | 将 active 团队转换为 `disabled` |
| `ctx.teams.enable(request)` | 将 disabled 团队转换为 `active` |
| `ctx.teams.delete(request)` | 软删除 active 或 disabled 团队；删除是终态 |
| `ctx.teams.addMember(request)` | 在所声明租户拥有该团队时，将 `UserId` 加入 active 团队；已 removed 的配对可以用新的 membership id 重新加入 |
| `ctx.teams.getMembership(teamId, userId)` | 返回当前成员槽位，不存在时返回 `undefined` |
| `ctx.teams.requireActiveMembership(teamId, userId)` | 要求团队和成员关系都处于 active |
| `ctx.teams.disableMembership(request)` | 将 active 成员关系转换为 `disabled` |
| `ctx.teams.enableMembership(request)` | 将 disabled 成员关系转换为 `active` |
| `ctx.teams.removeMembership(request)` | 在提交后撤销 active 或 disabled 成员关系；对该 membership id 而言移除是终态 |
| `ctx.teams.listMembers(query)` | 按状态筛选并返回一个团队的一页成员关系 |
| `ctx.teams.listUserTeams(query)` | 按状态筛选并返回一个用户在一个租户内的一页团队成员关系 |

核心职责仍然很小：在一个租户下创建或解析稳定的团队，以及判断用户当前是否在该团队中拥有可用成员关系。管理、revision、分页和事件只是安全维护这些事实，不负责认证、授权调用者，也不计算 `RoleUse` 或 `ObjectUse`。

## 团队与成员记录

`TeamRecord` 包含 `teamId`、`tenantId`、可选 `displayName`、`status`、`createdAt`、`updatedAt` 和 `revision`。`teamId` 由 Provider 生成，调用者不能选择。团队在其生命周期内属于恰好一个租户。团队状态只有 `active`、`disabled` 和 `deleted`，`deleted` 之后不能再次转换。

`TeamMembershipRecord` 包含 `membershipId`、`teamId`、`tenantId`、`userId`、`status`、`createdAt`、`updatedAt` 和 `revision`。`membershipId` 由 Provider 生成。成员状态只有 `active`、`disabled` 和 `removed`，`removed` 之后不能再次转换。每个 `(teamId, userId)` 只有一个当前槽位。若该用户已有 active 或 disabled 成员关系，再次加入会以 `membership-conflict` 失败。在 `removed` 之后重新加入会创建新的 `TeamMembershipId`，revision 从 1 开始。

`addMember` 要求所声明的 `tenantId` 与团队已存储的租户一致。不一致时以 `tenant-mismatch` 失败，并且不创建槽位。踢人是撤销：`removeMembership` 提交终态成员行，然后发出 `team/membership-changed`，以便缓存丢弃该配对。它不会把团队展开成每人一行的对象授权。

`revision` 从 1 开始，每次状态修改提交后严格增加 1。调用者把读取时的 revision 作为 `expectedRevision` 发送；发生并发修改时，过期操作以 `revision-conflict` 失败，而不会静默覆盖较新的数据。

角色、对象授权、Credential 和租户目录查询不能放入这些记录。`requireActiveMembership` 只检查本目录，不调用 `ctx.tenants` 或 `ctx.users`。

## 实现 Provider

Provider 继承 `TeamDirectory`，并把该子类作为唯一 `teams` 服务挂载。它实现七个 protected 操作：创建和读取团队、原子修改团队、创建和读取成员关系、原子修改成员关系，以及列出一页成员关系。基类负责校验、不可变分离结果、意外错误归一化，以及 Provider 成功提交后的事件。

`mutateTeamRecord()` 和 `mutateMembershipRecord()` 原子比较 `expectedRevision`、提交新记录，并返回准确的 `previous` 和 `current` 记录。`team-not-found`、`membership-conflict`、`status-conflict`、`revision-conflict` 等预期失败使用 `TeamDirectoryError`；意外存储错误转换为 `provider-unavailable`。

`tests/contract.ts` 中的共享套件是 Provider 的规范测试。仓库内每个 Provider 都要导入 `runTeamDirectoryContract()`，并把它绑定到全新的空存储介质。

## 管理员操作

是否可以管理团队或成员关系由调用方判断，不由 `dsh-team` 判断。典型管理员加入按照以下顺序进行：

```text
transport credential
  -> dsh-auth establishes actorUserId
  -> later authorization requires team:member.add
  -> ctx.teams.addMember({ teamId, tenantId, userId, context })
  -> Provider commits and team/membership-changed carries actorUserId, reason, and correlationId
```

`actorUserId` 与目标 `userId` 是两个独立值。Operation context 是可信审计元数据，不是授权证明。

## 事件

每次成功创建团队或转换团队状态都会在 Provider 提交后发出 `team/changed`。每次成功创建成员关系或转换成员状态（包括撤销）都会发出 `team/membership-changed`。不可变事件包含 id、已提交 revision、status、Provider 时间、修改类型，以及可选的操作者、关联 id 和原因。事件排除显示名、角色、授权、Credential 和 Provider 诊断。

监听器失败会被隔离并记录，因此一个观察者不能回滚已经提交的记录，也不能阻止后续观察者。同步 invariant 失败会在所有监听器运行后继续抛出。这些 live event 可用于审计、缓存失效和投影；持久化外部事件流仍需要 Provider 拥有的事务 outbox。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | 显示名、revision、上下文字段、成员状态筛选或列表范围无效 |
| `team-not-found` | 稳定团队 id 没有对应记录 |
| `team-disabled` | `requireActive()` 或 `addMember()` 找到已禁用团队；`requireActiveMembership()` 在检查成员状态之前报告此错误 |
| `team-deleted` | 团队已经终态删除，或不能执行请求的团队操作 |
| `tenant-mismatch` | `addMember()` 声明的租户并不拥有该团队 |
| `membership-not-found` | 团队处于 active，且 `(teamId, userId)` 没有成员关系 |
| `membership-disabled` | `requireActiveMembership()` 在 active 团队上找到已禁用成员关系 |
| `membership-removed` | 成员关系已经终态移除，或不能执行请求的成员操作 |
| `membership-conflict` | 该配对已经存在 active 或 disabled 成员关系 |
| `status-conflict` | 当前状态不允许请求的生命周期转换 |
| `revision-conflict` | 调用者读取后记录已经发生变化 |
| `provider-unavailable` | Provider 意外失败或返回无效结果 |

传输适配器根据防止团队或成员枚举的需要，决定哪些内部分类应折叠成同一种公开响应。

## 模型体验

### 团队目录状态

#### 模型看到什么

什么也看不到。团队记录、成员关系、operation context 和 `team/changed` 事件只存在于 Host；该包不注册可能向模型暴露这些数据的 prompt section、工具或 Session event。

#### Token 影响

为零。团队目录操作不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。团队目录变化不会改变模型可见的请求前缀，因此不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **没有生产 Provider** - MySQL 包必须拥有 schema、migration、索引、事务、cursor 编码和数据库错误分类。
- **没有角色或授权** - 角色绑定和对象 ACL 行属于后续的 `dsh-auth-rbac` 和 `dsh-authority-acl` 包。
- **没有授权** - 调用者是否可以创建团队或修改成员关系，在调用该服务之前决定。
- **没有租户目录查询** - 该服务接受品牌化 `TenantId` 和 `UserId`，不要求也不调用 `ctx.tenants` 或 `ctx.users`。
- **没有持久化审计投递** - `team/changed` 和 `team/membership-changed` 是进程内事件；持久化审计或集成事件流需要持久化 Provider 中的事务 outbox。
- **没有物理擦除工作流** - 软删除和移除保留稳定引用；跨领域的合规擦除需要独立的协调工作流。
