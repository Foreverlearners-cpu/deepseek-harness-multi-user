# Agent Note: MySQL user-directory Provider

Status: proposed

English | [中文](2026-08-23-dsh-user-mysql-provider.zh.md)

## Problem

The provider-neutral [`dsh-user` directory](2026-08-23-dsh-user-directory-service.md) needs durable multi-process storage without transferring credential, authorization, tenant, or connection-pool ownership into the user service. Its optimistic revision and lifecycle guarantees require database operations that remain atomic under concurrent processes.

## Proposal

Add `@deepseek-ai/dsh-user-mysql` as a concrete `UserDirectory` subclass over the Host-only `ctx.mysql` connection service. The Provider owns `dsh_user_schema`, `dsh_users`, its indexes, SQL, schema version, cursor encoding, and storage error mapping. It neither changes `dsh-user` nor extends `dsh-mysql`.

Schema version 1 stores one row per stable Provider-generated UUID. The primary key uses binary ASCII comparison; `(status, user_id)` supports both filtered and unfiltered ascending keyset scans. Profile extensions use MySQL JSON, while their validation and size limits remain owned by `dsh-user`.

Each mutation opens a transaction and locks the target row with `SELECT ... FOR UPDATE`. It checks absence, expected revision, terminal deletion, and the requested status transition before an update guarded by the same revision. It rereads the row and commits before the base service emits `user/changed`. Rollback failures and ambiguous database outcomes become `provider-unavailable`; expected directory conflicts keep their stable codes only after a successful rollback.

List cursors encode a version, the exclusive `user_id` lower bound, and the optional status filter. A cursor is opaque to Consumers and cannot be reused under a different filter. Invalid cursor data produces `invalid-input`; driver and row-decoding failures produce `provider-unavailable`.

## Alternatives considered

**Put SQL in `dsh-user`.** Rejected because the Service Definition must remain usable with other storage Providers and must not require Host database connectivity.

**Add transactions and migrations to `dsh-mysql` first.** Rejected for this stage because the current callback-scoped connection already exposes driver transactions. Domain tables and migration policy belong to this Provider until repeated Consumers establish a useful infrastructure abstraction.

**Use offset pagination.** Rejected because concurrent inserts and lifecycle changes make offsets skip or repeat unrelated rows, and large offsets require scanning discarded rows.

**Publish the live event inside the transaction.** Rejected because listener execution can block or fail while locks are held, and a live callback cannot participate atomically in MySQL commit. Durable delivery requires a future transactional outbox.

## Consequences

The Provider gives one MySQL-backed deployment durable user lifecycle and revision semantics while credentials and permissions remain independent. UUID order is stable but not creation order. Soft-deleted records remain addressable and consume keyspace. Schema version mismatch fails startup because the repository has no released persistent compatibility promise.

## Acceptance criteria

- The plugin supplies the unchanged `ctx.users` API through `ctx.mysql` and owns no credential or authorization data.
- Concurrent mutations serialize on the user row, enforce the expected revision and lifecycle transition, and emit no base-service event before commit.
- Status-filtered and unfiltered pages use status-bound keyset cursors; malformed or mismatched cursors fail as `invalid-input`.
- Unexpected schema, connection, SQL, row-decoding, commit, and rollback failures cross the directory API only as `provider-unavailable`.
- Focused keyless tests meet the repository's per-file coverage threshold, while real MySQL verification remains gated by `DSH_MYSQL_TEST_URL`.

## Risks

- MySQL DDL commits independently, so startup can leave version metadata or a table after later schema initialization fails. A subsequent activation deterministically verifies and completes the same version-1 schema.
- A commit failure can leave its outcome unknown to the caller. The Provider reports `provider-unavailable` and never retries a mutation whose commit may have reached the server.
- UUID key order distributes inserts but does not preserve account creation order. Consumers that need chronological administration require a separately specified cursor and index rather than inferring order from this API.

## Verification

The shared Provider suite runs against a stateful MySQL test double. Provider tests pin schema compatibility, keyset/filter cursor validation, rollback preservation, storage-error redaction, and malformed row rejection. An environment-gated test using `DSH_MYSQL_TEST_URL` covers real schema creation and durable profile/status mutation.
