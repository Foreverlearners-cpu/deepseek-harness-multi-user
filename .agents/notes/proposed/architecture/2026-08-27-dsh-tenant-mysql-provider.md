# Agent Note: MySQL tenant-directory Provider

Status: proposed

English | [中文](2026-08-27-dsh-tenant-mysql-provider.zh.md)

## Problem

The provider-neutral [`dsh-tenant` directory](2026-08-26-dsh-tenant-directory-service.md) needs durable multi-process storage without transferring roles, teams, object grants, or connection-pool ownership into the tenant service. Its optimistic revision and one-slot-per-pair membership guarantees require database operations that remain atomic under concurrent processes.

## Proposal

Add `@deepseek-ai/dsh-tenant-mysql` as a concrete `TenantDirectory` subclass over the Host-only `ctx.mysql` connection service. The Provider owns `dsh_tenant_schema`, `dsh_tenants`, `dsh_tenant_memberships`, their indexes, SQL, schema version, cursor encoding, and storage error mapping. It neither changes `dsh-tenant` nor extends `dsh-mysql`.

Schema version 1 stores one tenant row per Provider-generated UUID and one current membership slot per `(tenant_id, user_id)`. The tenant primary key and membership unique `membership_id` use binary ASCII comparison. `(tenant_id, status, membership_id)` and `(user_id, status, membership_id)` support filtered and unfiltered ascending keyset scans. Re-adding a removed pair updates the same unique slot with a new `membership_id` and revision 1.

Tenant mutations open a transaction and lock the tenant row with `SELECT ... FOR UPDATE`. Membership creation locks the tenant row first, then the membership slot, so a concurrent tenant disable and member add share one lock order. Membership status mutations lock only the membership slot. Updates check absence, expected revision, and the requested lifecycle transition, then write with a revision predicate, reread, and commit before the base service emits events. Rollback failures and ambiguous database outcomes become `provider-unavailable`; expected directory conflicts keep their stable codes only after a successful rollback.

List cursors encode a version, the exclusive `membership_id` lower bound, the optional status filter, and the tenant or user scope id. A cursor is opaque to Consumers and cannot be reused under a different filter or scope. Invalid cursor data produces `invalid-input`; driver and row-decoding failures produce `provider-unavailable`.

## Alternatives considered

**Put SQL in `dsh-tenant`.** Rejected because the Service Definition must remain usable with other storage Providers and must not require Host database connectivity.

**Add transactions and migrations to `dsh-mysql` first.** Rejected for this stage because the current callback-scoped connection already exposes driver transactions. Domain tables and migration policy belong to this Provider until repeated Consumers establish a useful infrastructure abstraction.

**Use offset pagination.** Rejected because concurrent inserts and lifecycle changes make offsets skip or repeat unrelated rows, and large offsets require scanning discarded rows.

**Expand a team or user grant into per-user membership rows.** Rejected because this package is the tenant directory, not ACL storage. One `(tenant_id, user_id)` slot is the current membership fact; later ACL packages must not explode team subjects here.

**Publish the live event inside the transaction.** Rejected because listener execution can block or fail while locks are held, and a live callback cannot participate atomically in MySQL commit. Durable delivery requires a future transactional outbox.

## Consequences

The Provider gives one MySQL-backed deployment durable tenant and membership lifecycle and revision semantics while roles, teams, and object grants remain independent. UUID order is stable but not creation order. Soft-deleted tenants and removed membership slots remain addressable and consume keyspace. Schema version mismatch fails startup because the repository has no released persistent compatibility promise.

## Acceptance criteria

- The plugin supplies the unchanged `ctx.tenants` API through `ctx.mysql` and owns no role, team, or object-grant data.
- Concurrent tenant and membership mutations serialize on the locked rows, enforce the expected revision and lifecycle transition, and emit no base-service event before commit.
- Status-filtered and unfiltered tenant-scoped and user-scoped pages use bound keyset cursors; malformed or mismatched cursors fail as `invalid-input`.
- Unexpected schema, connection, SQL, row-decoding, commit, and rollback failures cross the directory API only as `provider-unavailable`.
- Focused keyless tests meet the repository's per-file coverage threshold, while real MySQL verification remains gated by `DSH_MYSQL_TEST_URL`.

## Risks

- MySQL DDL commits independently, so startup can leave version metadata or a table after later schema initialization fails. A subsequent activation deterministically verifies and completes the same version-1 schema.
- A commit failure can leave its outcome unknown to the caller. The Provider reports `provider-unavailable` and never retries a mutation whose commit may have reached the server.
- UUID key order distributes inserts but does not preserve tenant or membership creation order. Consumers that need chronological administration require a separately specified cursor and index rather than inferring order from this API.

## Verification

The shared Provider suite runs against a stateful MySQL test double. Provider tests pin schema compatibility, keyset/filter/scope cursor validation, lock order, rollback preservation, storage-error redaction, and malformed row rejection. An environment-gated test using `DSH_MYSQL_TEST_URL` covers real schema creation and concurrent membership revision conflicts.
