# Agent Note: dsh-session-persistence-mysql provider

Status: proposed

English | [中文](2026-08-24-dsh-session-persistence-mysql-provider.zh.md)

## Problem

The decoupled delivery plan forbids adding `userId` to core `SessionHeader` or `CreateSessionOptions` and forbids adding a `transaction()` convenience method to the upstream MySQL service. The coupled candidate did both: session headers carried the owner, and providers called `ctx.mysql.transaction(...)`. A user-scoped MySQL `SessionPersistence` provider must keep ownership in its own schema and own its transaction sequence inside the upstream connection lease.

## Proposal

Add `@deepseek-ai/dsh-session-persistence-mysql` under `packages/session/session-persistence-mysql` as a MySQL implementation of the existing `SessionPersistence` service. It reuses `PersistenceCoordinator` for bounded write-behind, checkpoints, recovery, and disposal, stores packed logical event records (chunk runs gzip-compressed) with checksums, and loads them back exactly.

### Ownership

One provider instance is bound to one configured `ownerUserId`. Every read, list, and append filters or stamps the provider-owned `owner_kind`/`owner_id` columns; `SessionHeader` carries no user identity. The configured owner must be active (`ctx.users.requireActive`) before the backend is exposed.

### Transactions

`appendBatch` leases one connection through `ctx.mysql.connection(callback)`, runs `beginTransaction`/`commit`/`rollback` itself, locks the session row, verifies the stored owner and next expected sequence, inserts immutable records, and advances the revision and cursor. No convenience method is added to `packages/multi/mysql`.

## Alternatives considered

**Add `userId` to core session headers.** Not adopted: optional persistence would impose its identity model on every DSH deployment and make core packages depend on an optional plugin convention.

**Add `transaction()` to the upstream MySQL service.** Not adopted: providers must consume unmodified upstream packages; the upstream lease already permits begin, commit, and rollback inside the callback.

## Acceptance criteria

- No change to `packages/core/session`, `packages/core/agent`, `packages/core/agent-loop`, or `packages/multi/mysql`.
- Ownership is enforced by provider-owned schema columns, never by session header fields.
- `appendBatch` owns its transaction inside one upstream connection lease; failure rolls back and leaves the session unchanged.
- Round-trip, chunk packing, cross-user rejection, and disabled-owner startup are covered by MySQL integration tests plus transaction unit tests.

## Risks

Transaction correctness depends on the upstream lease contract restoring connections after failed commits or rollbacks. Sequence verification is single-writer per session; concurrent writers are rejected by the locked-row check. The provider is tenant-runtime scoped: request-level identity for shared processes is deferred.
