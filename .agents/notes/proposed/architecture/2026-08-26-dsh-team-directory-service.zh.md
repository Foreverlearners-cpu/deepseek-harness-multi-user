# Agent Note: dsh-team directory service

Status: proposed

[English](2026-08-26-dsh-team-directory-service.md) | 中文

## Problem

授权、管理工具和审计 Consumer 需要一个稳定的团队标识（该团队恰好属于一个租户），以及一个权威来源来判断人类用户当前是否属于该团队。租户成员关系只回答用户是否在该租户中。登录身份、显示名和 authenticated-call 来源各有不同的所有权和变更规则，因此都不能替代这个团队成员关系事实。

把团队行放进 `dsh-tenant`，会把租户成员关系耦合到一个独立变化的多对多关系上，并诱使把角色挂在租户上。把被踢出的成员展开成每人一行的对象授权，会在团队变大时撑爆表。在这里计算 `RoleUse` 或 `ObjectUse`，会把目录事实与授权混在一起。

在加入 MySQL Provider 或授权之前，仓库需要一个与 Provider 无关的团队目录。该服务必须定义团队身份、租户所有权、成员生命周期、并发、失败和 Provider 义务，但不创建数据库 schema，也不决定 ALLOW 或 DENY。

## Proposal

新增 `@deepseek-ai/dsh-team`，作为团队记录和用户成员关系的 Service Definition。它拥有品牌化 `TeamId` 和 `TeamMembershipId`、不可变记录字段、生命周期操作、与 Provider 无关的失败、有界 live event，以及共享的 Provider 一致性套件。部署时挂载恰好一个 Service Provider 来提供 `ctx.teams`。

`dsh-team` 没有生产环境回退，也不依赖 MySQL、Redis、HTTP、Session、授权或认证实现包。它可以依赖 Cordis、仓库品牌化 id 工具、invariant，仅用于品牌化 `UserId` 及其校验器的 `dsh-user`，以及仅用于品牌化 `TenantId` 及其校验器的 `dsh-tenant`。仅仅挂载 `dsh-team` 不会创建团队、认证请求，或改变现有产品路由。

该目录只表示团队和成员是否可用。角色挂在后续按团队划分的 RBAC 记录上。对象授权仍是 ACL 的职责。租户成员关系仍由 `dsh-tenant` 负责。本包不调用 `ctx.tenants` 或 `ctx.users`。

## Team and membership records

拟议的公开团队记录包含这些字段：

| Field | Meaning |
| --- | --- |
| `teamId` | Provider 生成的品牌化身份，不会改变，也不会回到另一个团队。 |
| `tenantId` | 从 `dsh-tenant` 导入的品牌化租户；团队在其生命周期内恰好属于这个租户。 |
| `displayName` | 可选的面向人的标签；它不是登录标识或授权事实。 |
| `status` | 封闭生命周期值：`active`、`disabled` 或 `deleted`。 |
| `createdAt` | Provider 选择的非负纪元毫秒创建时间。 |
| `updatedAt` | 最近一次已提交修改的非负纪元毫秒时间。 |
| `revision` | 每次已提交修改递增的单调乐观并发值。 |

拟议的公开成员记录包含这些字段：

| Field | Meaning |
| --- | --- |
| `membershipId` | Provider 生成的一个成员槽位品牌化身份。 |
| `teamId` | 拥有该槽位的团队。 |
| `tenantId` | 加入时从团队复制的租户，以便按用户列出时保持租户边界。 |
| `userId` | 从 `dsh-user` 导入的品牌化人类用户；本包不查询 `ctx.users`。 |
| `status` | 封闭生命周期值：`active`、`disabled` 或 `removed`。 |
| `createdAt` | Provider 选择的非负纪元毫秒创建时间。 |
| `updatedAt` | 最近一次已提交修改的非负纪元毫秒时间。 |
| `revision` | 每次已提交修改递增的单调乐观并发值。 |

每个 `(teamId, userId)` 只有一个当前槽位。active 或 disabled 槽位不能重复。对该 `TeamMembershipId` 而言 `removed` 是终态；再次加入同一配对会创建新的 id。角色、ACL 授权、Credential 和 extensions 都不是这两类记录上的字段。

## Directory operations

Service Definition 暴露团队的 `create`、`get`、`requireActive`、`disable`、`enable` 和 `delete`，以及成员关系的 `addMember`、`getMembership`、`requireActiveMembership`、`disableMembership`、`enableMembership`、`removeMembership`、`listMembers` 和 `listUserTeams`。每个 Provider 都保持这些语义：

- 创建要求品牌化 `TenantId`，校验可选显示名，生成新的 `TeamId`，从 `active` 开始，初始化 revision，并返回已提交记录。
- 读取返回一个团队或明确的缺失，不改变生命周期状态。
- 要求可用只对 `active` 返回当前团队；缺失、已禁用和已删除团队产生不同的内部失败码。
- 禁用只接受 `active`；启用只接受 `disabled`；软删除接受 `active` 或 `disabled`，并且是终态。
- 加入成员要求团队处于 active，要求所声明租户等于团队的租户，生成新的 `TeamMembershipId`，并在已存在 active 或 disabled 槽位时以 `membership-conflict` 失败。租户不一致以 `tenant-mismatch` 失败，并且不写入。
- 要求可用成员关系先检查团队，并在成员码之前报告 `team-disabled` 或 `team-deleted`。
- 移除成员关系是撤销：它提交终态行，然后发出 `team/membership-changed` 供缓存失效。它不写每人一行的授权。
- 列表操作使用有界 limit 和不透明 cursor，并支持可选状态筛选。列出缺失团队的成员会失败；列出一个用户的团队要求租户 id，不要求 `ctx.users` 或 `ctx.tenants`。
- 修改可以携带可信的 `actorUserId`、原因和关联元数据，供审计 Consumer 使用。这些元数据不能证明授权。

## Lifecycle and concurrency

允许的团队转换为 `active -> disabled`、`disabled -> active`、`active -> deleted` 和 `disabled -> deleted`。允许的成员转换为 `active -> disabled`、`disabled -> active`、`active -> removed` 和 `disabled -> removed`。终态不能再次转换。重复转换不会静默成功。

每次修改都会把 `expectedRevision` 与当前记录比较，并原子提交新数据和递增后的 revision。过期 revision 产生 `revision-conflict`，不会部分改变 status、时间戳或事件。Provider 从自己的可信时钟选择时间戳；调用者不能写入 `createdAt`、`updatedAt` 或 `revision`。

该包为无效输入、缺失、团队或成员不可用、租户不一致、重复的当前成员关系、无效转换、revision 冲突、Provider 不可用和意外 Provider 失败定义稳定失败。存储特定错误码不能越过服务 API。

## Events and Consumers

修改提交后，服务发出 `team/changed` 或 `team/membership-changed`。事件包含相关 id、已提交 revision、status、事件时间，以及调用方提供的操作者、原因和关联元数据。它们排除显示名、角色、授权、Credential、传输证据和 Provider 诊断。

这些事件是供审计、缓存失效和投影使用的进程内集成事实。它们不是 Session event，不会进入模型可见回放，也不能替代持久化 Provider 拥有的事务 outbox。

后续的 `dsh-auth-rbac`、`dsh-authority` 和 `dsh-authority-acl` Consumer 使用 `TeamId` 和成员可用性，但保留自己的状态和决策。`dsh-auth` 继续只签发身份。

## Provider ownership

`dsh-team` 不拥有表、migration、文件、缓存、环境变量或网络客户端。后续的 `dsh-team-mysql` Provider 将拥有物理团队和成员表、索引、事务、migration version 和 MySQL 错误分类。它的 schema 提案必须实现本记录和生命周期契约，而不能把角色或对象授权加入该目录。

共享一致性套件会对每个 Provider 实现运行。它覆盖 id 品牌化和唯一性、每个团队恰好一个租户、同租户多团队成员关系、跨租户加入拒绝、生命周期转换、终态删除和撤销、撤销后重新加入、乐观并发、cursor 稳定性、事件时机和脱敏、失败归一化，以及 Provider 处置。

## Alternatives considered

**把被踢出的成员展开成每个资源一行个人对象授权。** 否决，因为团队规模会倍增授权行。踢人是撤销成员槽位；后续 ACL 继续把团队当作主体。

**把角色挂在租户上而不是团队上。** 否决，因为授权设计把 `RoleUse` 限定在一个团队。租户范围的角色会混合团队，并破坏同团队相交。

**把团队成员关系放进 `dsh-tenant` 或租户成员行。** 否决，因为一个租户成员可以加入多个团队，而且团队成员关系可以独立于租户成员关系变化。[租户目录 Agent Note](2026-08-26-dsh-tenant-directory-service.md) 已经把团队记录分配给 `dsh-team`。

**注入 `ctx.tenants`，并在 `addMember` 之前要求可用的租户成员关系。** 否决，因为本 Service Definition 应保持与 Provider 无关，并且不应变成租户 Consumer。调用方提供品牌化 `TenantId`；后续授权 Consumer 可以同时要求两个目录。

**在本包中计算 `RoleUse` 或 `ObjectUse`，或决定 ALLOW/DENY。** 否决，因为这些决定属于 `dsh-authority` 及其 RBAC/ACL Provider。

## Acceptance criteria

- 该包定义品牌化 `TeamId` 和 `TeamMembershipId`、团队和成员记录、状态生命周期、与 Provider 无关的操作、稳定失败分类、有界事件，以及 Provider 一致性套件。
- 该包不导入认证实现、授权、Session、传输、数据库或缓存包，也不打开外部资源。它只可以为 `UserId` 导入 `dsh-user`，只可以为 `TenantId` 导入 `dsh-tenant`。
- 团队和成员创建在已挂载 Provider 内生成 id；一个团队恰好属于一个租户；状态修改使用强制乐观并发；已删除团队 id 和已移除成员 id 是终态。
- `addMember` 拒绝并不拥有该团队的所声明租户；`requireActiveMembership` 在成员码之前报告团队不可用；重新加入已移除配对会创建新的 `TeamMembershipId`。
- 撤销后，该配对的 active 成员列表查询为空；撤销事件只在提交后发出。
- Provider 事件只在提交后发生，并排除显示名、角色、授权、Credential 和诊断；它们永远不会进入 Session event log。
- 聚焦测试覆盖同租户多团队成员关系、跨租户加入拒绝、撤销后为空、每一种生命周期转换和拒绝、过期并发修改、cursor 分页、事件脱敏、监听器隔离和 Provider 处置。
- 只添加 `dsh-team` 时，现有 Session、Agent、认证、租户目录和已发布 bundle 行为保持不变。
- MySQL schema、角色、ACL 授权和产品路由集成仍是各自拥有独立所有者的后续变更。

## Risks

- 只围绕第一个 MySQL Provider 设计的目录 API 可能泄漏 SQL 分页、时间戳或事务假设。不透明 cursor、Provider 拥有的时钟和共享一致性套件必须保持 L1 行为与 Provider 无关。
- 不同的内部不可用失败可以帮助管理，但直接映射到公开响应时可能泄漏团队或成员是否存在。传输 Consumer 必须在需要抵抗枚举的地方折叠它们。
- 软删除和移除保留引用和可审计性，但本身不能满足未来的物理擦除策略。擦除和保留需要独立的跨领域工作流。
- 把 Service Definition 与每个 Provider 分开会增加包和组合数量。这种分离是有意的，这样存储以及后续 RBAC 或 ACL 选择就不会修改成员 Consumer，但后续 starter 包必须让合法组合保持直接。
