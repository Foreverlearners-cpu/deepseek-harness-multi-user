# @deepseek-ai/dsh-user

English | [中文](README.zh.md)

Provider-independent Host directory for human users. The service gives each account a stable `UserId` and answers whether that account currently exists and is active. Profile and lifecycle operations maintain those two facts.

This package is the Service Definition. It creates no table and stores no password, login name, role, tenant membership, token, or session. A deployment mounts one concrete Provider, such as a future `dsh-user-mysql`, as `ctx.users`.

## Public API

| API | Purpose |
|---|---|
| `ctx.users.create(input)` | Create an active user with a Provider-generated stable id and revision 1 |
| `ctx.users.get(userId)` | Return the current record or `undefined` |
| `ctx.users.requireActive(userId)` | Return an active record or distinguish missing, disabled, and deleted users |
| `ctx.users.update(request)` | Replace selected profile fields using `expectedRevision` |
| `ctx.users.disable(request)` | Move an active user to `disabled` |
| `ctx.users.enable(request)` | Move a disabled user to `active` |
| `ctx.users.delete(request)` | Soft-delete an active or disabled user; deletion is terminal |
| `ctx.users.list(query)` | Return a status-filtered page with an opaque continuation cursor |

The core responsibilities remain small: create or resolve a stable user record, and determine whether that user is currently usable. Management, revision, pagination, and events safely maintain those facts; they do not authenticate or authorize a caller.

## User Record

`UserRecord` contains `userId`, optional `displayName`, `status`, `createdAt`, `updatedAt`, `revision`, and `extensions`. The Provider generates `userId`; callers cannot choose it. `active`, `disabled`, and `deleted` are the only statuses, and `deleted` cannot transition again.

`revision` starts at 1 and increases by exactly one for every committed profile or status mutation. A caller sends the revision it read as `expectedRevision`; a concurrent mutation makes a stale operation fail with `revision-conflict` instead of silently overwriting newer data.

`extensions` is a JSON object, not a JSON-encoded string. Top-level keys are namespaced, values are deeply detached and frozen, nesting is capped at 16, and encoded data is capped at 16 KiB. Credentials, roles, tenant membership, lifecycle state, login identifiers, secrets, and indexed business fields do not belong in extensions.

## Implementing a Provider

A Provider subclasses `UserDirectory` and mounts that subclass as the sole `users` service. It implements four protected operations: create a record, read a record, atomically mutate a record, and list a page. The base class owns validation, detached immutable results, unexpected-failure normalization, and `user/changed` emission after a successful Provider commit.

`mutateRecord()` receives either a profile mutation or a status mutation. The Provider atomically compares `expectedRevision`, commits the new record, and returns the exact `previous` and `current` records. It throws `UserDirectoryError` for expected failures such as `user-not-found`, `status-conflict`, and `revision-conflict`; unexpected storage errors become `provider-unavailable`.

The shared suite in `tests/contract.ts` is the normative Provider test. Every in-repository Provider imports `runUserDirectoryContract()` and binds it to a fresh empty storage medium.

## Administrator Operations

The caller, not `dsh-user`, decides who may manage another user. A typical administrative update follows this order:

```text
transport credential
  -> dsh-auth establishes actorUserId
  -> dsh-auth-rbac requires user:update
  -> business service validates allowed fields
  -> ctx.users.update({ userId: targetUserId, patch, expectedRevision, context })
  -> Provider commits and user/changed carries actorUserId, reason, and correlationId
```

`actorUserId` and the target `userId` are separate values. Operation context is trusted audit metadata, not proof of authorization. Password reset uses the password-credential Provider, and user disablement may be consumed by a session or token-revocation plugin; neither operation belongs in profile update.

## Events

Every successful create, profile update, and status transition emits `user/changed` after the Provider commit. The immutable event contains the user id, committed revision, status, Provider timestamp, change kind, and optional actor, correlation, and reason metadata. It excludes display name, extensions, login identifiers, credentials, and Provider diagnostics.

Listener failures are contained and logged so one observer cannot roll back a committed user or starve later observers. Synchronous invariant failures remain fatal after every listener runs. The live event supports audit, cache invalidation, and projections; a durable external stream still requires a Provider-owned transactional outbox.

## Failure Semantics

| Code | Meaning |
|---|---|
| `invalid-input` | A profile value, extension, revision, context field, or list bound is invalid |
| `user-not-found` | The stable user id has no record |
| `user-disabled` | `requireActive()` found a disabled user |
| `user-deleted` | The user is terminally deleted or cannot perform the requested operation |
| `status-conflict` | The requested lifecycle transition is not valid from the current status |
| `revision-conflict` | The record changed after the caller read it |
| `provider-unavailable` | The Provider failed unexpectedly or returned an invalid result |

Transport adapters decide which internal categories to collapse into one public response to prevent user enumeration.

## Model Experience

### User directory state

#### What the model sees

Nothing. User records, operation context, and `user/changed` events are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. User directory operations do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. User directory changes do not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **No production Provider** - a MySQL package must own the schema, migrations, indexes, transactions, cursor encoding, and database error classification.
- **No login credentials** - username, email, password verifier, API key, JWT, and refresh-token storage belong to authentication Provider packages mapped to `UserId`.
- **No authorization or tenancy** - administrative permission and tenant membership checks occur before calling this service.
- **No durable audit delivery** - `user/changed` is process-local; a durable audit or integration stream requires a transactional outbox in the persistence Provider.
- **No physical erasure workflow** - soft deletion preserves stable references; cross-domain regulatory erasure requires a separate coordinated workflow.
