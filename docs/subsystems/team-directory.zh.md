# 团队目录

[English](team-directory.md) | 中文

团队目录子系统是 [`@deepseek-ai/dsh-team`](../../packages/identity/team/README.md)，它是用于稳定团队记录（每个团队恰好属于一个租户）和权威用户成员生命周期状态的 Host-only Service Definition。具体 Provider 提供 `ctx.teams`；认证、授权、租户查询、Credential 和存储保持独立所有权。

该包只是 Service Definition。后续的 MySQL Provider 将拥有目录表、schema version、行事务和 cursor 编码，并使用独立的 `ctx.mysql` 连接服务。

## 记录与生命周期

`TeamRecord` 使用 Provider 生成的 `TeamId` 和恰好一个 `TenantId` 标识一个团队。它包含可选显示名、`active`/`disabled`/`deleted` 状态、Provider 时间戳和单调 revision。删除是终态，id 永远不会重新分配。

`TeamMembershipRecord` 使用 Provider 生成的 `TeamMembershipId` 标识一个 `(teamId, userId)` 配对的当前槽位。它包含团队的 `tenantId`、`active`/`disabled`/`removed` 状态、Provider 时间戳和单调 revision。移除是对该 membership id 的撤销，不会把团队展开成每人一行授权；再次加入同一配对会创建新的 id。角色和 ACL 授权不是成员字段。

## 乐观修改

状态修改包含 `expectedRevision`。Provider 原子比较并写入、将 revision 增加 1，并返回准确的修改前后记录。Service Definition 在向调用者或事件监听器发布前验证该提交。

`addMember` 拒绝并不拥有该团队的所声明租户。`requireActiveMembership` 先检查团队。即使成员行仍是 active，已禁用或已删除团队也会产生团队失败。

## Provider 职责

一个 Provider 实现团队的创建/读取/修改、成员关系的创建/读取/修改，以及有界 cursor 分页。基础服务校验并分离结果、归一化意外失败，而且只在提交后发出脱敏事件。MySQL Provider 将拥有 schema 和事务；它不会把角色或对象授权移入目录记录。

## 授权与审计

业务服务在调用 `ctx.teams` 前认证操作者，并执行管理员权限检查。可选的操作者、原因和关联元数据是审计上下文，不是授权证明。`team/changed` 和 `team/membership-changed` 排除显示名，供进程内审计、缓存和投影消费方使用。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxteams--teamdirectory-abstract-seam"></a>

### `ctx.teams` — `TeamDirectory` (abstract seam)

Abstract team directory. Providers own durable records and atomic revision checks; this base owns validation, stable failures, detached results, and post-commit events.

```ts cordis-catalog
/** Create one active team under one tenant with a Provider-generated stable id.
 * @param input - owning tenant, optional display name, and trusted operation metadata.
 * @returns immutable committed team record.
 */
async create(input: TeamCreateInput): Promise<TeamRecord>

/** Get one current team record.
 * @param id - stable team identity.
 * @returns immutable record, or undefined when absent.
 */
async get(id: TeamId): Promise<TeamRecord | undefined>

/** Require that one team exists and is currently active.
 * @param id - stable team identity.
 * @returns immutable active team record.
 */
async requireActive(id: TeamId): Promise<TeamRecord>

/** Disable one active team using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable disabled team record.
 */
disable(request: TeamStatusRequest): Promise<TeamRecord>

/** Enable one disabled team using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable active team record.
 */
enable(request: TeamStatusRequest): Promise<TeamRecord>

/** Soft-delete one active or disabled team using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable terminal team record.
 */
delete(request: TeamStatusRequest): Promise<TeamRecord>

/** Add one user to one active team. The claimed tenant must match the team's tenant.
 * A removed pair may be re-added under a new membership id.
 * @param request - team, claimed tenant, user, and trusted operation metadata.
 * @returns immutable committed membership record.
 */
async addMember(request: TeamMemberAddRequest): Promise<TeamMembershipRecord>

/** Get the current membership slot for one team and user.
 * @param id - stable team identity.
 * @param member - stable user identity.
 * @returns immutable record, or undefined when the pair was never added.
 */
async getMembership(id: TeamId, member: UserId): Promise<TeamMembershipRecord | undefined>

/** Require that one team and one membership are both currently active.
 * @param id - stable team identity.
 * @param member - stable user identity.
 * @returns immutable active membership record.
 */
async requireActiveMembership(id: TeamId, member: UserId): Promise<TeamMembershipRecord>

/** Disable one active membership using optimistic concurrency.
 * @param request - team, user, expected revision, and operation metadata.
 * @returns immutable disabled membership record.
 */
disableMembership(request: TeamMembershipStatusRequest): Promise<TeamMembershipRecord>

/** Enable one disabled membership using optimistic concurrency.
 * @param request - team, user, expected revision, and operation metadata.
 * @returns immutable active membership record.
 */
enableMembership(request: TeamMembershipStatusRequest): Promise<TeamMembershipRecord>

/** Revoke one active or disabled membership using optimistic concurrency.
 * @param request - team, user, expected revision, and operation metadata.
 * @returns immutable terminal membership record.
 */
removeMembership(request: TeamMembershipStatusRequest): Promise<TeamMembershipRecord>

/** List one bounded page of memberships for one team.
 * @param query - team, optional status, limit, and opaque cursor.
 * @returns immutable page and optional continuation cursor.
 */
async listMembers(query: TeamMemberListQuery): Promise<TeamMembershipPage>

/** List one bounded page of one user's team memberships inside one tenant.
 * @param query - user, tenant, optional status, limit, and opaque cursor.
 * @returns immutable page and optional continuation cursor.
 */
async listUserTeams(query: UserTeamListQuery): Promise<TeamMembershipPage>
```

Types: [TenantId](tenant-directory.md), [UserId](user-directory.md)

Source: [`packages/identity/team/src/index.ts:339`](../../packages/identity/team/src/index.ts)

<a id="team-events"></a>

### `team/*` events

<a id="teamchanged--emit"></a>

#### `team/changed` — emit

Committed team-directory change without display names.

```ts cordis-catalog
/**
 * Committed team-directory change without display names.
 * @param event - sanitized lifecycle fact safe for trusted audit listeners.
 * @mode emit
 */
'team/changed'(event: TeamChangeEvent): void
```

Source: [`packages/identity/team/src/types.ts:224`](../../packages/identity/team/src/types.ts)

<a id="teammembership-changed--emit"></a>

#### `team/membership-changed` — emit

Committed membership change without display names, roles, or grants.

```ts cordis-catalog
/**
 * Committed membership change without display names, roles, or grants.
 * @param event - sanitized membership fact safe for trusted audit listeners.
 * @mode emit
 */
'team/membership-changed'(event: TeamMembershipChangeEvent): void
```

Source: [`packages/identity/team/src/types.ts:230`](../../packages/identity/team/src/types.ts)
<!-- END GENERATED cordis-surface -->
