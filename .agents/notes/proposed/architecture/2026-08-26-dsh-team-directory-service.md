# Agent Note: dsh-team directory service

Status: proposed

English | [中文](2026-08-26-dsh-team-directory-service.zh.md)

## Problem

Authorization, administration tools, and audit Consumers need one stable identifier for a team that lives under exactly one tenant, and one authoritative source for whether a human user currently belongs to that team. Tenant membership answers only whether the user is in the tenant. Login identity, display names, and authenticated-call provenance each have different ownership and change rules, so none can substitute for that team-membership fact.

Putting team rows onto `dsh-tenant` would couple tenant membership to an independently changing many-to-many relation and would invite hanging roles on the tenant. Expanding a kicked member into per-user object grants would explode tables when a team grows. Computing `RoleUse` or `ObjectUse` here would mix directory facts with authorization.

The repository needs a provider-neutral team directory before it adds a MySQL Provider or authorization. The service must define team identity, tenant ownership, membership lifecycle, concurrency, failures, and Provider obligations without creating a database schema or deciding ALLOW or DENY.

## Proposal

Add `@deepseek-ai/dsh-team` as the Service Definition for team records and user memberships. It owns the branded `TeamId` and `TeamMembershipId`, immutable record fields, lifecycle operations, provider-neutral failures, bounded live events, and a shared Provider conformance suite. A deployment mounts exactly one Service Provider to supply `ctx.teams`.

`dsh-team` has no production fallback and does not depend on MySQL, Redis, HTTP, Session, authorization, or authentication implementation packages. It may depend on Cordis, the repository branded-id utility, invariants, `dsh-user` only for the branded `UserId` and its validator, and `dsh-tenant` only for the branded `TenantId` and its validator. Merely mounting `dsh-team` does not create a team, authenticate a request, or change an existing product route.

The directory represents teams and membership usability only. Roles hang on later team-scoped RBAC records. Object grants remain an ACL concern. Tenant membership remains `dsh-tenant`. This package does not call `ctx.tenants` or `ctx.users`.

## Team and membership records

The proposed public team record contains these fields:

| Field | Meaning |
| --- | --- |
| `teamId` | Provider-generated branded identity that never changes or returns to another team. |
| `tenantId` | Branded tenant imported from `dsh-tenant`; a team belongs to exactly this tenant for its lifetime. |
| `displayName` | Optional human-facing label; it is not a login identifier or authorization fact. |
| `status` | Closed lifecycle value: `active`, `disabled`, or `deleted`. |
| `createdAt` | Non-negative epoch-millisecond creation time chosen by the Provider. |
| `updatedAt` | Non-negative epoch-millisecond time of the latest committed mutation. |
| `revision` | Monotonic optimistic-concurrency value incremented by each committed mutation. |

The proposed public membership record contains these fields:

| Field | Meaning |
| --- | --- |
| `membershipId` | Provider-generated branded identity of one membership slot. |
| `teamId` | Team that owns the slot. |
| `tenantId` | Tenant copied from the team at add time so user-scoped lists stay tenant-bounded. |
| `userId` | Branded human user imported from `dsh-user`; this package does not look up `ctx.users`. |
| `status` | Closed lifecycle value: `active`, `disabled`, or `removed`. |
| `createdAt` | Non-negative epoch-millisecond creation time chosen by the Provider. |
| `updatedAt` | Non-negative epoch-millisecond time of the latest committed mutation. |
| `revision` | Monotonic optimistic-concurrency value incremented by each committed mutation. |

One current slot exists per `(teamId, userId)`. An active or disabled slot cannot be duplicated. `removed` is terminal for that `TeamMembershipId`; adding the same pair again creates a new id. Roles, ACL grants, credentials, and extensions are not fields on either record.

## Directory operations

The Service Definition exposes team `create`, `get`, `requireActive`, `disable`, `enable`, and `delete`, plus membership `addMember`, `getMembership`, `requireActiveMembership`, `disableMembership`, `enableMembership`, `removeMembership`, `listMembers`, and `listUserTeams`. Every Provider preserves these semantics:

- Create requires a branded `TenantId`, validates the optional display name, generates a new `TeamId`, starts at `active`, initializes revision, and returns the committed record.
- Get returns one team or an explicit absence without changing lifecycle state.
- Require-active returns the current team only for `active`; missing, disabled, and deleted teams produce distinct internal failure codes.
- Disable accepts only `active`; enable accepts only `disabled`; soft-delete accepts `active` or `disabled` and is terminal.
- Add-member requires an active team, requires the claimed tenant to equal the team's tenant, generates a new `TeamMembershipId`, and fails with `membership-conflict` when an active or disabled slot already exists. A tenant mismatch fails with `tenant-mismatch` and writes nothing.
- Require-active-membership checks the team first and reports `team-disabled` or `team-deleted` before membership codes.
- Remove-membership is revoke: it commits the terminal row and then emits `team/membership-changed` for cache invalidation. It does not write per-user grants.
- List operations use a bounded limit and opaque cursor with optional status filtering. Listing members of a missing team fails; listing one user's teams requires a tenant id and does not require `ctx.users` or `ctx.tenants`.
- Mutations may carry trusted `actorUserId`, reason, and correlation metadata for audit Consumers. This metadata does not prove authorization.

## Lifecycle and concurrency

Allowed team transitions are `active -> disabled`, `disabled -> active`, `active -> deleted`, and `disabled -> deleted`. Allowed membership transitions are `active -> disabled`, `disabled -> active`, `active -> removed`, and `disabled -> removed`. Terminal states do not transition again. Repeating a transition does not silently succeed.

Every mutation compares `expectedRevision` with the current record and commits the new data and incremented revision atomically. A stale revision produces `revision-conflict` and does not partially change status, timestamps, or events. The Provider chooses timestamps from its trusted clock; callers cannot write `createdAt`, `updatedAt`, or `revision`.

The package defines stable failures for invalid input, absence, inactive team or membership state, tenant mismatch, duplicate current membership, invalid transition, revision conflict, unavailable Provider, and unexpected Provider failure. Storage-specific error codes never cross the service API.

## Events and Consumers

After a mutation commits, the service emits `team/changed` or `team/membership-changed`. Events include the relevant ids, the committed revision, status, event time, and available caller-supplied actor, reason, and correlation metadata. They exclude display names, roles, grants, credentials, transport evidence, and Provider diagnostics.

These events are process-local integration facts for audit, cache invalidation, and projections. They are not Session events, do not enter model-visible replay, and do not replace a durable transactional outbox owned by a persistence Provider.

Later `dsh-auth-rbac`, `dsh-authority`, and `dsh-authority-acl` Consumers use `TeamId` and membership usability but retain their own state and decisions. `dsh-auth` continues to mint identity only.

## Provider ownership

`dsh-team` owns no tables, migrations, files, caches, environment variables, or network clients. A later `dsh-team-mysql` Provider will own the physical team and membership tables, indexes, transactions, migration version, and MySQL error classification. Its schema proposal must implement this record and lifecycle contract without adding roles or object grants to the directory.

A shared conformance suite runs against every Provider implementation. It covers id branding and uniqueness, one tenant per team, same-tenant multi-team membership, cross-tenant add refusal, lifecycle transitions, terminal deletion and revoke, re-add after revoke, optimistic concurrency, cursor stability, event timing and redaction, failure normalization, and Provider disposal.

## Alternatives considered

**Expand a kicked member into one personal object grant per resource.** Rejected because team size would multiply grant rows. Kick is revoke of the membership slot; later ACL continues to name the team as a subject.

**Hang roles on the tenant instead of the team.** Rejected because the authorization design scopes `RoleUse` to a team. A tenant-wide role would mix teams and break same-team intersect.

**Put team membership on `dsh-tenant` or the tenant membership row.** Rejected because a tenant member may join several teams and team membership can change independently of tenant membership. The [tenant-directory Agent Note](2026-08-26-dsh-tenant-directory-service.md) already assigned team records to `dsh-team`.

**Inject `ctx.tenants` and require an active tenant membership before `addMember`.** Rejected for this Service Definition so the package stays provider-neutral and does not become a tenant Consumer. Callers supply a branded `TenantId`; a later authority Consumer can require both directories.

**Compute `RoleUse` or `ObjectUse`, or decide ALLOW/DENY, in this package.** Rejected because those decisions belong to `dsh-authority` and its RBAC/ACL Providers.

## Acceptance criteria

- The package defines branded `TeamId` and `TeamMembershipId`, team and membership records, status lifecycles, provider-neutral operations, stable failure categories, bounded events, and a Provider conformance suite.
- The package imports no authentication implementation, authorization, Session, transport, database, or cache package and opens no external resource. It may import `dsh-user` only for `UserId` and `dsh-tenant` only for `TenantId`.
- Team and membership creation generate ids inside the mounted Provider; a team belongs to exactly one tenant; status mutations use mandatory optimistic concurrency; deleted team ids and removed membership ids are terminal.
- `addMember` refuses a claimed tenant that does not own the team; `requireActiveMembership` reports team inactivity before membership codes; re-adding a removed pair creates a new `TeamMembershipId`.
- After revoke, active membership list queries for that pair are empty; the revoke event is emitted only after commit.
- Provider events occur only after commit and exclude display names, roles, grants, credentials, and diagnostics; they never enter the Session event log.
- Focused tests cover same-tenant multi-team membership, cross-tenant add refusal, revoke emptiness, every lifecycle transition and refusal, stale concurrent mutation, cursor pagination, event redaction, listener containment, and Provider disposal.
- Existing Session, Agent, authentication, tenant-directory, and shipped bundle behavior remains unchanged when only `dsh-team` is added.
- The MySQL schema, roles, ACL grants, and product-route integration remain separate follow-up changes with their own owners.

## Risks

- A directory API designed around only the first MySQL Provider could leak SQL pagination, timestamp, or transaction assumptions. Opaque cursors, provider-owned clocks, and the shared conformance suite must keep the L1 behavior provider-neutral.
- Distinct internal inactive-state failures can support administration but may leak team or membership existence when mapped directly to a public response. Transport Consumers must collapse them where enumeration resistance requires it.
- Soft deletion and removal preserve references and auditability but do not satisfy a future physical-erasure policy by themselves. Erasure and retention need a separate cross-domain workflow.
- Separating the Service Definition from every Provider increases package and composition count. The separation is intentional so storage and later RBAC or ACL choices do not modify membership Consumers, but a later starter package must make valid compositions straightforward.
