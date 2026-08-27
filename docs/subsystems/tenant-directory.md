# Tenant Directory

English | [中文](tenant-directory.zh.md)

The tenant-directory subsystem is [`@deepseek-ai/dsh-tenant`](../../packages/identity/tenant/README.md), a Host-only Service Definition for stable tenant records and authoritative user-membership lifecycle state. A concrete Provider supplies `ctx.tenants`; authentication, authorization, teams, credentials, and storage remain independent owners.

[`@deepseek-ai/dsh-tenant-mysql`](../../packages/identity/tenant-mysql/README.md) is the durable MySQL Provider. It owns the directory tables, schema version, row transactions, and keyset cursor encoding while using the separate `ctx.mysql` connection service.

## Record and lifecycle

`TenantRecord` identifies one tenant with a Provider-generated `TenantId`. It carries an optional display name, `active`/`disabled`/`deleted` status, Provider timestamps, and a monotonic revision. Deletion is terminal, and an id is never reassigned.

`MembershipRecord` identifies the current slot for one `(tenantId, userId)` pair with a Provider-generated `MembershipId`. It carries `active`/`disabled`/`removed` status, Provider timestamps, and a monotonic revision. Removal is terminal for that membership id; adding the same pair again creates a new id. Roles and team bindings are not membership fields.

## Optimistic mutation

Status mutations include `expectedRevision`. The Provider compares and writes atomically, increments revision by one, and returns the exact before and after records. The Service Definition validates that commit before publishing it to the caller or event listeners.

`requireActiveMembership` checks the tenant first. A disabled or deleted tenant produces a tenant failure even when the membership row is still active.

## Provider responsibilities

One Provider implements tenant create/read/mutate, membership create/read/mutate, and bounded cursor pages. The base service validates and detaches results, normalizes unexpected failures, and emits sanitized events only after a commit. The MySQL Provider owns schema and transactions; it does not move roles or team ownership into the directory record.

## Authorization and audit

Business services authenticate the actor and enforce administrative permission before invoking `ctx.tenants`. Optional actor, reason, and correlation metadata is audit context, not authorization proof. `tenant/changed` and `tenant/membership-changed` exclude display names and support process-local audit, cache, and projection consumers.

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
