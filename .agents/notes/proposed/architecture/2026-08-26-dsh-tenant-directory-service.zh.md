# Agent Note: dsh-tenant directory service

Status: proposed

[English](2026-08-26-dsh-tenant-directory-service.md) | 中文

## Problem

授权、团队成员、管理工具和审计 Consumer 需要一个稳定的租户标识，以及一个权威来源来判断人类用户当前是否属于该租户。登录身份、会话拥有的租户字段、显示名和 authenticated-call 来源各有不同的所有权和变更规则，因此都不能替代这个成员关系事实。

把租户行或成员关系放进 `dsh-user`，会把账号生命周期耦合到一个独立变化的多对多关系上。把租户放进 `AuthenticatedCall`，会让身份携带授权范围。复用 `ConversationTenantId`，会让一个产品存储拥有后续团队和授权插件都必须共享的标识。

在加入 MySQL Provider、团队或授权之前，仓库需要一个与 Provider 无关的租户目录。该服务必须定义租户身份、成员生命周期、并发、失败和 Provider 义务，但不创建数据库 schema，也不决定调用者是否可以管理租户。

## Proposal

新增 `@deepseek-ai/dsh-tenant`，作为租户记录和用户成员关系的 Service Definition。它拥有品牌化 `TenantId` 和 `MembershipId`、不可变记录字段、生命周期操作、与 Provider 无关的失败、有界 live event，以及共享的 Provider 一致性套件。部署时挂载恰好一个 Service Provider 来提供 `ctx.tenants`。

`dsh-tenant` 没有生产环境回退，也不依赖 MySQL、Redis、HTTP、Session、团队、授权或认证实现包。它可以依赖 Cordis、仓库品牌化 id 工具、invariant，以及仅用于品牌化 `UserId` 及其校验器的 `dsh-user`。仅仅挂载 `dsh-tenant` 不会创建租户、认证请求，或改变现有产品路由。

该目录只表示租户和成员是否可用。角色挂在后续的团队记录上。对象授权仍是 ACL 的职责。会话持久化继续使用自己的 `ConversationTenantId`，直到后续 mapping Consumer 连接这两个标识。

## Tenant and membership records

拟议的公开租户记录包含这些字段：

| Field | Meaning |
| --- | --- |
| `tenantId` | Provider 生成的品牌化身份，不会改变，也不会回到另一个租户。 |
| `displayName` | 可选的面向人的标签；它不是登录标识或授权事实。 |
| `status` | 封闭生命周期值：`active`、`disabled` 或 `deleted`。 |
| `createdAt` | Provider 选择的非负纪元毫秒创建时间。 |
| `updatedAt` | 最近一次已提交修改的非负纪元毫秒时间。 |
| `revision` | 每次已提交修改递增的单调乐观并发值。 |

拟议的公开成员记录包含这些字段：

| Field | Meaning |
| --- | --- |
| `membershipId` | Provider 生成的一个成员槽位品牌化身份。 |
| `tenantId` | 拥有该槽位的租户。 |
| `userId` | 从 `dsh-user` 导入的品牌化人类用户；本包不查询 `ctx.users`。 |
| `status` | 封闭生命周期值：`active`、`disabled` 或 `removed`。 |
| `createdAt` | Provider 选择的非负纪元毫秒创建时间。 |
| `updatedAt` | 最近一次已提交修改的非负纪元毫秒时间。 |
| `revision` | 每次已提交修改递增的单调乐观并发值。 |

每个 `(tenantId, userId)` 只有一个当前槽位。active 或 disabled 槽位不能重复。对该 `MembershipId` 而言 `removed` 是终态；再次加入同一配对会创建新的 id。角色、团队、ACL、Credential 和 extensions 都不是这两类记录上的字段。

## Directory operations

Service Definition 暴露租户的 `create`、`get`、`requireActive`、`disable`、`enable` 和 `delete`，以及成员关系的 `addMember`、`getMembership`、`requireActiveMembership`、`disableMembership`、`enableMembership`、`removeMembership`、`listMembers` 和 `listUserMemberships`。每个 Provider 都保持这些语义：

- 创建会校验可选显示名，生成新的 `TenantId`，从 `active` 开始，初始化 revision，并返回已提交记录。
- 读取返回一个租户或明确的缺失，不改变生命周期状态。
- 要求可用只对 `active` 返回当前租户；缺失、已禁用和已删除租户产生不同的内部失败码。
- 禁用只接受 `active`；启用只接受 `disabled`；软删除接受 `active` 或 `disabled`，并且是终态。
- 加入成员要求租户处于 active，生成新的 `MembershipId`，并在已存在 active 或 disabled 槽位时以 `membership-conflict` 失败。
- 要求可用成员关系先检查租户，并在成员码之前报告 `tenant-disabled` 或 `tenant-deleted`。
- 列表操作使用有界 limit 和不透明 cursor，并支持可选状态筛选。列出缺失租户的成员会失败；列出一个用户的成员关系不要求 `ctx.users`。
- 修改可以携带可信的 `actorUserId`、原因和关联元数据，供审计 Consumer 使用。这些元数据不能证明授权。

## Lifecycle and concurrency

允许的租户转换为 `active -> disabled`、`disabled -> active`、`active -> deleted` 和 `disabled -> deleted`。允许的成员转换为 `active -> disabled`、`disabled -> active`、`active -> removed` 和 `disabled -> removed`。终态不能再次转换。重复转换不会静默成功。

每次修改都会把 `expectedRevision` 与当前记录比较，并原子提交新数据和递增后的 revision。过期 revision 产生 `revision-conflict`，不会部分改变 status、时间戳或事件。Provider 从自己的可信时钟选择时间戳；调用者不能写入 `createdAt`、`updatedAt` 或 `revision`。

该包为无效输入、缺失、租户或成员不可用、重复的当前成员关系、无效转换、revision 冲突、Provider 不可用和意外 Provider 失败定义稳定失败。存储特定错误码不能越过服务 API。

## Events and Consumers

修改提交后，服务发出 `tenant/changed` 或 `tenant/membership-changed`。事件包含相关 id、已提交 revision、status、事件时间，以及调用方提供的操作者、原因和关联元数据。它们排除显示名、角色、Credential、传输证据和 Provider 诊断。

这些事件是供审计、缓存失效和投影使用的进程内集成事实。它们不是 Session event，不会进入模型可见回放，也不能替代持久化 Provider 拥有的事务 outbox。

后续的 `dsh-team`、`dsh-authority` 和 `dsh-tenant-authority` Consumer 使用 `TenantId` 和成员可用性，但保留自己的状态和决策。`dsh-auth` 继续只签发身份。

## Provider ownership

`dsh-tenant` 不拥有表、migration、文件、缓存、环境变量或网络客户端。后续的 `dsh-tenant-mysql` Provider 将拥有物理租户和成员表、索引、事务、migration version 和 MySQL 错误分类。它的 schema 提案必须实现本记录和生命周期契约，而不能把角色或团队所有权加入该目录。

共享一致性套件会对每个 Provider 实现运行。它覆盖 id 品牌化和唯一性、生命周期转换、终态删除和移除、移除后重新加入、乐观并发、cursor 稳定性、事件时机和脱敏、失败归一化，以及 Provider 处置。

## Alternatives considered

**把租户成员关系放进 `dsh-user`。** 否决，因为一个用户可以属于多个租户，而且成员关系可以独立于账号资料和生命周期变化。用户目录 Agent Note 已经把这些记录分配给 `dsh-tenant`。

**把 `tenantId` 放进 `AuthenticatedCall`。** 否决，因为认证回答的是调用者是谁，而不是他们可以使用哪个租户。把租户放在身份对象上会强迫每个已认证请求选择一个租户，并把身份与授权范围混在一起。

**把 `ConversationTenantId` 复用为 Host 租户 id。** 否决，因为会话持久化拥有该品牌及其存储。团队和授权插件需要一个目录身份，而不是会话产品的外键。

**在成员行上存储角色或团队 id。** 否决，因为角色挂在团队上，对象授权是另一条 ACL 路线。把这张表扩成 user × team × role，正是成员槽位要避免的膨胀。

**把缺失成员关系当作允许。** 否决，因为授权设计是默认拒绝。缺失或不可用的成员关系是明确拒绝，不是隐式授予。

## Acceptance criteria

- 该包定义品牌化 `TenantId` 和 `MembershipId`、租户和成员记录、状态生命周期、与 Provider 无关的操作、稳定失败分类、有界事件，以及 Provider 一致性套件。
- 该包不导入认证实现、授权、团队、Session、传输、数据库或缓存包，也不打开外部资源。它只可以为 `UserId` 导入 `dsh-user`。
- 租户和成员创建在已挂载 Provider 内生成 id；状态修改使用强制乐观并发；已删除租户 id 和已移除成员 id 是终态。
- `requireActiveMembership` 在成员码之前报告租户不可用；重新加入已移除配对会创建新的 `MembershipId`。
- Provider 事件只在提交后发生，并排除显示名、角色、Credential 和诊断；它们永远不会进入 Session event log。
- 聚焦测试覆盖每一种生命周期转换和拒绝、过期并发修改、cursor 分页、事件脱敏、监听器隔离和 Provider 处置。
- 只添加 `dsh-tenant` 时，现有 Session、Agent、认证和已发布 bundle 行为保持不变。
- MySQL schema、团队、角色、ACL 授权和产品路由集成仍是各自拥有独立所有者的后续变更。

## Risks

- 只围绕第一个 MySQL Provider 设计的目录 API 可能泄漏 SQL 分页、时间戳或事务假设。不透明 cursor、Provider 拥有的时钟和共享一致性套件必须保持 L1 行为与 Provider 无关。
- 不同的内部不可用失败可以帮助管理，但直接映射到公开响应时可能泄漏租户或成员是否存在。传输 Consumer 必须在需要抵抗枚举的地方折叠它们。
- 软删除和移除保留引用和可审计性，但本身不能满足未来的物理擦除策略。擦除和保留需要独立的跨领域工作流。
- 把 Service Definition 与每个 Provider 分开会增加包和组合数量。这种分离是有意的，这样存储以及后续团队或授权选择就不会修改成员 Consumer，但后续 starter 包必须让合法组合保持直接。
