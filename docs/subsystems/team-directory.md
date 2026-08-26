# Team Directory

English | [中文](team-directory.zh.md)

The team-directory subsystem is [`@deepseek-ai/dsh-team`](../../packages/identity/team/README.md), a Host-only Service Definition for stable team records bound to one tenant and authoritative user-membership lifecycle state. A concrete Provider supplies `ctx.teams`; authentication, authorization, tenant lookup, credentials, and storage remain independent owners.

This package is the Service Definition only. A later MySQL Provider will own the directory tables, schema version, row transactions, and cursor encoding while using the separate `ctx.mysql` connection service.

## Record and lifecycle

`TeamRecord` identifies one team with a Provider-generated `TeamId` and exactly one `TenantId`. It carries an optional display name, `active`/`disabled`/`deleted` status, Provider timestamps, and a monotonic revision. Deletion is terminal, and an id is never reassigned.

`TeamMembershipRecord` identifies the current slot for one `(teamId, userId)` pair with a Provider-generated `TeamMembershipId`. It carries the team's `tenantId`, `active`/`disabled`/`removed` status, Provider timestamps, and a monotonic revision. Removal is revoke for that membership id and does not expand the team into per-user grants; adding the same pair again creates a new id. Roles and ACL grants are not membership fields.

## Optimistic mutation

Status mutations include `expectedRevision`. The Provider compares and writes atomically, increments revision by one, and returns the exact before and after records. The Service Definition validates that commit before publishing it to the caller or event listeners.

`addMember` rejects a claimed tenant that does not own the team. `requireActiveMembership` checks the team first. A disabled or deleted team produces a team failure even when the membership row is still active.

## Provider responsibilities

One Provider implements team create/read/mutate, membership create/read/mutate, and bounded cursor pages. The base service validates and detaches results, normalizes unexpected failures, and emits sanitized events only after a commit. A MySQL Provider will own schema and transactions; it does not move roles or object grants into the directory record.

## Authorization and audit

Business services authenticate the actor and enforce administrative permission before invoking `ctx.teams`. Optional actor, reason, and correlation metadata is audit context, not authorization proof. `team/changed` and `team/membership-changed` exclude display names and support process-local audit, cache, and projection consumers.

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
