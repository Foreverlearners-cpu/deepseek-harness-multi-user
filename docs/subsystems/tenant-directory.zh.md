# 租户目录

[English](tenant-directory.md) | 中文

租户目录子系统是 [`@deepseek-ai/dsh-tenant`](../../packages/identity/tenant/README.md)，它是用于稳定租户记录和权威用户成员生命周期状态的 Host-only Service Definition。具体 Provider 提供 `ctx.tenants`；认证、授权、团队、Credential 和存储保持独立所有权。

[`@deepseek-ai/dsh-tenant-mysql`](../../packages/identity/tenant-mysql/README.md) 是持久 MySQL Provider。它拥有目录表、schema version、行事务和 keyset cursor 编码，并使用独立的 `ctx.mysql` 连接服务。

## 记录与生命周期

`TenantRecord` 使用 Provider 生成的 `TenantId` 标识一个租户。它包含可选显示名、`active`/`disabled`/`deleted` 状态、Provider 时间戳和单调 revision。删除是终态，id 永远不会重新分配。

`MembershipRecord` 使用 Provider 生成的 `MembershipId` 标识一个 `(tenantId, userId)` 配对的当前槽位。它包含 `active`/`disabled`/`removed` 状态、Provider 时间戳和单调 revision。对该 membership id 而言移除是终态；再次加入同一配对会创建新的 id。角色和团队绑定不是成员字段。

## 乐观修改

状态修改包含 `expectedRevision`。Provider 原子比较并写入、将 revision 增加 1，并返回准确的修改前后记录。Service Definition 在向调用者或事件监听器发布前验证该提交。

`requireActiveMembership` 先检查租户。即使成员行仍是 active，已禁用或已删除租户也会产生租户失败。

## Provider 职责

一个 Provider 实现租户的创建/读取/修改、成员关系的创建/读取/修改，以及有界 cursor 分页。基础服务校验并分离结果、归一化意外失败，而且只在提交后发出脱敏事件。MySQL Provider 拥有 schema 和事务；它不会把角色或团队所有权移入目录记录。

## 授权与审计

业务服务在调用 `ctx.tenants` 前认证操作者，并执行管理员权限检查。可选的操作者、原因和关联元数据是审计上下文，不是授权证明。`tenant/changed` 和 `tenant/membership-changed` 排除显示名，供进程内审计、缓存和投影消费方使用。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtenants--tenantdirectory-abstract-seam"></a>

### `ctx.tenants` — `TenantDirectory` (abstract seam)

Abstract tenant directory. Providers own durable records and atomic revision checks; this base owns validation, stable failures, detached results, and post-commit events.

```ts cordis-catalog
/** Create one active tenant with a Provider-generated stable id.
 * @param input - optional display name and trusted operation metadata.
 * @returns immutable committed tenant record.
 */
async create(input: TenantCreateInput = {}): Promise<TenantRecord>

/** Get one current tenant record.
 * @param id - stable tenant identity.
 * @returns immutable record, or undefined when absent.
 */
async get(id: TenantId): Promise<TenantRecord | undefined>

/** Require that one tenant exists and is currently active.
 * @param id - stable tenant identity.
 * @returns immutable active tenant record.
 */
async requireActive(id: TenantId): Promise<TenantRecord>

/** Disable one active tenant using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable disabled tenant record.
 */
disable(request: TenantStatusRequest): Promise<TenantRecord>

/** Enable one disabled tenant using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable active tenant record.
 */
enable(request: TenantStatusRequest): Promise<TenantRecord>

/** Soft-delete one active or disabled tenant using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable terminal tenant record.
 */
delete(request: TenantStatusRequest): Promise<TenantRecord>

/** Add one user to one active tenant. A removed pair may be re-added under a new membership id.
 * @param request - tenant, user, and trusted operation metadata.
 * @returns immutable committed membership record.
 */
async addMember(request: TenantMemberAddRequest): Promise<MembershipRecord>

/** Get the current membership slot for one tenant and user.
 * @param id - stable tenant identity.
 * @param member - stable user identity.
 * @returns immutable record, or undefined when the pair was never added.
 */
async getMembership(id: TenantId, member: UserId): Promise<MembershipRecord | undefined>

/** Require that one tenant and one membership are both currently active.
 * @param id - stable tenant identity.
 * @param member - stable user identity.
 * @returns immutable active membership record.
 */
async requireActiveMembership(id: TenantId, member: UserId): Promise<MembershipRecord>

/** Disable one active membership using optimistic concurrency.
 * @param request - tenant, user, expected revision, and operation metadata.
 * @returns immutable disabled membership record.
 */
disableMembership(request: MembershipStatusRequest): Promise<MembershipRecord>

/** Enable one disabled membership using optimistic concurrency.
 * @param request - tenant, user, expected revision, and operation metadata.
 * @returns immutable active membership record.
 */
enableMembership(request: MembershipStatusRequest): Promise<MembershipRecord>

/** Remove one active or disabled membership using optimistic concurrency.
 * @param request - tenant, user, expected revision, and operation metadata.
 * @returns immutable terminal membership record.
 */
removeMembership(request: MembershipStatusRequest): Promise<MembershipRecord>

/** List one bounded page of memberships for one tenant.
 * @param query - tenant, optional status, limit, and opaque cursor.
 * @returns immutable page and optional continuation cursor.
 */
async listMembers(query: TenantMemberListQuery): Promise<MembershipPage>

/** List one bounded page of memberships for one user.
 * @param query - user, optional status, limit, and opaque cursor.
 * @returns immutable page and optional continuation cursor.
 */
async listUserMemberships(query: UserMembershipListQuery): Promise<MembershipPage>
```

Types: [UserId](user-directory.md)

Source: [`packages/identity/tenant/src/index.ts:325`](../../packages/identity/tenant/src/index.ts)

<a id="tenant-events"></a>

### `tenant/*` events

<a id="tenantchanged--emit"></a>

#### `tenant/changed` — emit

Committed tenant-directory change without display names.

```ts cordis-catalog
/**
 * Committed tenant-directory change without display names.
 * @param event - sanitized lifecycle fact safe for trusted audit listeners.
 * @mode emit
 */
'tenant/changed'(event: TenantChangeEvent): void
```

Source: [`packages/identity/tenant/src/types.ts:212`](../../packages/identity/tenant/src/types.ts)

<a id="tenantmembership-changed--emit"></a>

#### `tenant/membership-changed` — emit

Committed membership change without display names or roles.

```ts cordis-catalog
/**
 * Committed membership change without display names or roles.
 * @param event - sanitized membership fact safe for trusted audit listeners.
 * @mode emit
 */
'tenant/membership-changed'(event: TenantMembershipChangeEvent): void
```

Source: [`packages/identity/tenant/src/types.ts:218`](../../packages/identity/tenant/src/types.ts)
<!-- END GENERATED cordis-surface -->
