# @deepseek-ai/dsh-team

English | [中文](README.zh.md)

Provider-independent Host directory for teams and their user memberships. The service gives each team a stable `TeamId` bound to exactly one `TenantId`, records whether a `UserId` currently belongs to that team, and answers which teams that user has inside one tenant.

This package is the Service Definition. It creates no table and stores no role, ACL grant, token, or session. A deployment mounts one concrete Provider as `ctx.teams`.

## Public API

| API | Purpose |
|---|---|
| `ctx.teams.create(input)` | Create an active team under one tenant with a Provider-generated stable id and revision 1 |
| `ctx.teams.get(teamId)` | Return the current team record or `undefined` |
| `ctx.teams.requireActive(teamId)` | Return an active team or distinguish missing, disabled, and deleted teams |
| `ctx.teams.disable(request)` | Move an active team to `disabled` |
| `ctx.teams.enable(request)` | Move a disabled team to `active` |
| `ctx.teams.delete(request)` | Soft-delete an active or disabled team; deletion is terminal |
| `ctx.teams.addMember(request)` | Add a `UserId` to an active team when the claimed tenant owns that team; a removed pair may be re-added under a new membership id |
| `ctx.teams.getMembership(teamId, userId)` | Return the current membership slot or `undefined` |
| `ctx.teams.requireActiveMembership(teamId, userId)` | Require that the team and the membership are both active |
| `ctx.teams.disableMembership(request)` | Move an active membership to `disabled` |
| `ctx.teams.enableMembership(request)` | Move a disabled membership to `active` |
| `ctx.teams.removeMembership(request)` | Revoke an active or disabled membership after commit; removal is terminal for that membership id |
| `ctx.teams.listMembers(query)` | Return a status-filtered page of one team's memberships |
| `ctx.teams.listUserTeams(query)` | Return a status-filtered page of one user's team memberships inside one tenant |

The core responsibilities remain small: create or resolve a stable team under one tenant, and determine whether a user currently has an active membership in that team. Management, revision, pagination, and events safely maintain those facts; they do not authenticate, authorize a caller, or compute `RoleUse` or `ObjectUse`.

## Team and membership records

`TeamRecord` contains `teamId`, `tenantId`, optional `displayName`, `status`, `createdAt`, `updatedAt`, and `revision`. The Provider generates `teamId`; callers cannot choose it. A team belongs to exactly one tenant for its lifetime. `active`, `disabled`, and `deleted` are the only team statuses, and `deleted` cannot transition again.

`TeamMembershipRecord` contains `membershipId`, `teamId`, `tenantId`, `userId`, `status`, `createdAt`, `updatedAt`, and `revision`. The Provider generates `membershipId`. `active`, `disabled`, and `removed` are the only membership statuses, and `removed` cannot transition again. One current slot exists per `(teamId, userId)`. Adding a user who already has an active or disabled membership fails with `membership-conflict`. Re-adding after `removed` creates a new `TeamMembershipId` at revision 1.

`addMember` requires the claimed `tenantId` to match the team's stored tenant. A mismatch fails with `tenant-mismatch` and does not create a slot. Kick is revoke: `removeMembership` commits the terminal membership row and then emits `team/membership-changed` so caches can drop that pair. It does not expand the team into per-user object grants.

`revision` starts at 1 and increases by exactly one for every committed status mutation. A caller sends the revision it read as `expectedRevision`; a concurrent mutation makes a stale operation fail with `revision-conflict` instead of silently overwriting newer data.

Roles, object grants, credentials, and tenant-directory lookups do not belong on these records. `requireActiveMembership` checks only this directory: it does not call `ctx.tenants` or `ctx.users`.

## Implementing a Provider

A Provider subclasses `TeamDirectory` and mounts that subclass as the sole `teams` service. It implements seven protected operations: create and read a team, atomically mutate a team, create and read a membership, atomically mutate a membership, and list a membership page. The base class owns validation, detached immutable results, unexpected-failure normalization, and event emission after a successful Provider commit.

`mutateTeamRecord()` and `mutateMembershipRecord()` atomically compare `expectedRevision`, commit the new record, and return the exact `previous` and `current` records. The Provider throws `TeamDirectoryError` for expected failures such as `team-not-found`, `membership-conflict`, `status-conflict`, and `revision-conflict`; unexpected storage errors become `provider-unavailable`.

The shared suite in `tests/contract.ts` is the normative Provider test. Every in-repository Provider imports `runTeamDirectoryContract()` and binds it to a fresh empty storage medium.

## Administrator Operations

The caller, not `dsh-team`, decides who may manage a team or membership. A typical administrative add follows this order:

```text
transport credential
  -> dsh-auth establishes actorUserId
  -> later authorization requires team:member.add
  -> ctx.teams.addMember({ teamId, tenantId, userId, context })
  -> Provider commits and team/membership-changed carries actorUserId, reason, and correlationId
```

`actorUserId` and the target `userId` are separate values. Operation context is trusted audit metadata, not proof of authorization.

## Events

Every successful team create or status transition emits `team/changed` after the Provider commit. Every successful membership create or status transition, including revoke, emits `team/membership-changed`. The immutable events contain ids, committed revision, status, Provider timestamp, change kind, and optional actor, correlation, and reason metadata. They exclude display names, roles, grants, credentials, and Provider diagnostics.

Listener failures are contained and logged so one observer cannot roll back a committed record or starve later observers. Synchronous invariant failures remain fatal after every listener runs. The live events support audit, cache invalidation, and projections; a durable external stream still requires a Provider-owned transactional outbox.

## Failure Semantics

| Code | Meaning |
|---|---|
| `invalid-input` | A display name, revision, context field, membership status filter, or list bound is invalid |
| `team-not-found` | The stable team id has no record |
| `team-disabled` | `requireActive()` or `addMember()` found a disabled team; `requireActiveMembership()` reports this before membership state |
| `team-deleted` | The team is terminally deleted or cannot perform the requested team operation |
| `tenant-mismatch` | `addMember()` claimed a tenant that does not own the team |
| `membership-not-found` | The team is active and the `(teamId, userId)` pair has no membership |
| `membership-disabled` | `requireActiveMembership()` found a disabled membership on an active team |
| `membership-removed` | The membership is terminally removed or cannot perform the requested membership operation |
| `membership-conflict` | An active or disabled membership already exists for the pair |
| `status-conflict` | The requested lifecycle transition is not valid from the current status |
| `revision-conflict` | The record changed after the caller read it |
| `provider-unavailable` | The Provider failed unexpectedly or returned an invalid result |

Transport adapters decide which internal categories to collapse into one public response to prevent team or membership enumeration.

## Model Experience

### Team directory state

#### What the model sees

Nothing. Team records, memberships, operation context, and `team/changed` events are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. Team directory operations do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Team directory changes do not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **MySQL persistence is a separate package** - [`dsh-team-mysql`](../team-mysql/README.md) owns the schema, indexes, transactions, cursor encoding, and database error classification.
- **No roles or grants** - role bindings and object ACL rows belong to later `dsh-auth-rbac` and `dsh-authority-acl` packages.
- **No authorization** - whether a caller may create a team or change membership is decided before invoking this service.
- **No tenant-directory lookup** - this service accepts branded `TenantId` and `UserId` values and does not require or call `ctx.tenants` or `ctx.users`.
- **No durable audit delivery** - `team/changed` and `team/membership-changed` are process-local; a durable audit or integration stream requires a transactional outbox in the persistence Provider.
- **No physical erasure workflow** - soft deletion and removal preserve stable references; cross-domain regulatory erasure requires a separate coordinated workflow.
