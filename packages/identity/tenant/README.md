# @deepseek-ai/dsh-tenant

English | [中文](README.zh.md)

Provider-independent Host directory for tenants and their user memberships. The service gives each tenant a stable `TenantId`, records whether a `UserId` currently belongs to that tenant, and answers whether that membership is usable.

This package is the Service Definition. It creates no table and stores no role, team, ACL, token, or session. A deployment mounts one concrete Provider as `ctx.tenants`.

## Public API

| API | Purpose |
|---|---|
| `ctx.tenants.create(input)` | Create an active tenant with a Provider-generated stable id and revision 1 |
| `ctx.tenants.get(tenantId)` | Return the current tenant record or `undefined` |
| `ctx.tenants.requireActive(tenantId)` | Return an active tenant or distinguish missing, disabled, and deleted tenants |
| `ctx.tenants.disable(request)` | Move an active tenant to `disabled` |
| `ctx.tenants.enable(request)` | Move a disabled tenant to `active` |
| `ctx.tenants.delete(request)` | Soft-delete an active or disabled tenant; deletion is terminal |
| `ctx.tenants.addMember(request)` | Add a `UserId` to an active tenant; a removed pair may be re-added under a new membership id |
| `ctx.tenants.getMembership(tenantId, userId)` | Return the current membership slot or `undefined` |
| `ctx.tenants.requireActiveMembership(tenantId, userId)` | Require that the tenant and the membership are both active |
| `ctx.tenants.disableMembership(request)` | Move an active membership to `disabled` |
| `ctx.tenants.enableMembership(request)` | Move a disabled membership to `active` |
| `ctx.tenants.removeMembership(request)` | Soft-remove an active or disabled membership; removal is terminal for that membership id |
| `ctx.tenants.listMembers(query)` | Return a status-filtered page of one tenant's memberships |
| `ctx.tenants.listUserMemberships(query)` | Return a status-filtered page of one user's memberships |

The core responsibilities remain small: create or resolve a stable tenant, and determine whether a user currently has an active membership in that tenant. Management, revision, pagination, and events safely maintain those facts; they do not authenticate or authorize a caller.

## Tenant and membership records

`TenantRecord` contains `tenantId`, optional `displayName`, `status`, `createdAt`, `updatedAt`, and `revision`. The Provider generates `tenantId`; callers cannot choose it. `active`, `disabled`, and `deleted` are the only tenant statuses, and `deleted` cannot transition again.

`MembershipRecord` contains `membershipId`, `tenantId`, `userId`, `status`, `createdAt`, `updatedAt`, and `revision`. The Provider generates `membershipId`. `active`, `disabled`, and `removed` are the only membership statuses, and `removed` cannot transition again. One current slot exists per `(tenantId, userId)`. Adding a user who already has an active or disabled membership fails with `membership-conflict`. Re-adding after `removed` creates a new `MembershipId` at revision 1.

`revision` starts at 1 and increases by exactly one for every committed status mutation. A caller sends the revision it read as `expectedRevision`; a concurrent mutation makes a stale operation fail with `revision-conflict` instead of silently overwriting newer data.

Roles, teams, object grants, credentials, and conversation-owned tenant ids do not belong on these records. `requireActiveMembership` checks only this directory: it does not call `ctx.users`.

## Implementing a Provider

A Provider subclasses `TenantDirectory` and mounts that subclass as the sole `tenants` service. It implements seven protected operations: create and read a tenant, atomically mutate a tenant, create and read a membership, atomically mutate a membership, and list a membership page. The base class owns validation, detached immutable results, unexpected-failure normalization, and event emission after a successful Provider commit.

`mutateTenantRecord()` and `mutateMembershipRecord()` atomically compare `expectedRevision`, commit the new record, and return the exact `previous` and `current` records. The Provider throws `TenantDirectoryError` for expected failures such as `tenant-not-found`, `membership-conflict`, `status-conflict`, and `revision-conflict`; unexpected storage errors become `provider-unavailable`.

The shared suite in `tests/contract.ts` is the normative Provider test. Every in-repository Provider imports `runTenantDirectoryContract()` and binds it to a fresh empty storage medium.

## Administrator Operations

The caller, not `dsh-tenant`, decides who may manage a tenant or membership. A typical administrative add follows this order:

```text
transport credential
  -> dsh-auth establishes actorUserId
  -> later authorization requires tenant:member.add
  -> ctx.tenants.addMember({ tenantId, userId, context })
  -> Provider commits and tenant/membership-changed carries actorUserId, reason, and correlationId
```

`actorUserId` and the target `userId` are separate values. Operation context is trusted audit metadata, not proof of authorization.

## Events

Every successful tenant create or status transition emits `tenant/changed` after the Provider commit. Every successful membership create or status transition emits `tenant/membership-changed`. The immutable events contain ids, committed revision, status, Provider timestamp, change kind, and optional actor, correlation, and reason metadata. They exclude display names, roles, credentials, and Provider diagnostics.

Listener failures are contained and logged so one observer cannot roll back a committed record or starve later observers. Synchronous invariant failures remain fatal after every listener runs. The live events support audit, cache invalidation, and projections; a durable external stream still requires a Provider-owned transactional outbox.

## Failure Semantics

| Code | Meaning |
|---|---|
| `invalid-input` | A display name, revision, context field, membership status filter, or list bound is invalid |
| `tenant-not-found` | The stable tenant id has no record |
| `tenant-disabled` | `requireActive()` or `addMember()` found a disabled tenant; `requireActiveMembership()` reports this before membership state |
| `tenant-deleted` | The tenant is terminally deleted or cannot perform the requested tenant operation |
| `membership-not-found` | The tenant is active and the `(tenantId, userId)` pair has no membership |
| `membership-disabled` | `requireActiveMembership()` found a disabled membership on an active tenant |
| `membership-removed` | The membership is terminally removed or cannot perform the requested membership operation |
| `membership-conflict` | An active or disabled membership already exists for the pair |
| `status-conflict` | The requested lifecycle transition is not valid from the current status |
| `revision-conflict` | The record changed after the caller read it |
| `provider-unavailable` | The Provider failed unexpectedly or returned an invalid result |

Transport adapters decide which internal categories to collapse into one public response to prevent tenant or membership enumeration.

## Model Experience

### Tenant directory state

#### What the model sees

Nothing. Tenant records, memberships, operation context, and `tenant/changed` events are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. Tenant directory operations do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Tenant directory changes do not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **MySQL persistence is a separate package** - [`dsh-tenant-mysql`](../tenant-mysql/README.md) owns the schema, indexes, transactions, cursor encoding, and database error classification.
- **No teams or roles** - team records and role bindings belong to later `dsh-team` and `dsh-auth-rbac` packages.
- **No authorization** - whether a caller may create a tenant or change membership is decided before invoking this service.
- **No user-directory lookup** - this service accepts branded `UserId` values and does not require or call `ctx.users`.
- **No durable audit delivery** - `tenant/changed` and `tenant/membership-changed` are process-local; a durable audit or integration stream requires a transactional outbox in the persistence Provider.
- **No physical erasure workflow** - soft deletion and removal preserve stable references; cross-domain regulatory erasure requires a separate coordinated workflow.
