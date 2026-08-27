# Agent Note: MySQL team-directory Provider

Status: proposed

English | [中文](2026-08-27-dsh-team-mysql-provider.zh.md)

## Problem

The provider-neutral [`dsh-team` directory](2026-08-26-dsh-team-directory-service.md) needs durable multi-process storage without transferring roles, object grants, or connection-pool ownership into the team service. Team rows must keep a single `tenant_id`. Kick must change membership status and revision in one transaction, and live events must wait for commit.

## Proposal

Add `@deepseek-ai/dsh-team-mysql` as a concrete `TeamDirectory` subclass over the Host-only `ctx.mysql` connection service. The Provider owns `dsh_team_schema`, `dsh_teams`, `dsh_team_memberships`, their indexes, SQL, schema version, cursor encoding, and storage error mapping. It neither changes `dsh-team` nor extends `dsh-mysql`.

Schema version 1 stores one team row per Provider-generated UUID with a required `tenant_id`, and one current membership slot per `(team_id, user_id)`. The membership table copies `tenant_id` for tenant-scoped user lists and stores no action, role, or grant columns. Re-adding a removed pair updates the same unique slot with a new `membership_id` and revision 1.

Team mutations lock the team row. Membership creation locks the team row first, then the membership slot, and rejects a claimed tenant that does not own the locked team. Kick is a membership status update to `removed` that increments revision in the same `UPDATE`. The base service emits `team/membership-changed` only after that transaction commits. Unexpected SQL and rollback failures become `provider-unavailable`.

List cursors encode a version, the exclusive `membership_id` lower bound, the optional status filter, and the team or user-and-tenant scope. A cursor cannot be reused under a different filter or scope.

## Alternatives considered

**Put SQL in `dsh-team`.** Rejected because the Service Definition must remain usable with other storage Providers and must not require Host database connectivity.

**Store RoleUse or object-grant actions on membership rows.** Rejected because kick and membership usability are directory facts; actions belong to later `dsh-auth-rbac` and `dsh-authority-acl` packages. Expanding a team into per-user grant rows would explode tables.

**Use offset pagination.** Rejected because concurrent inserts and lifecycle changes make offsets skip or repeat unrelated rows.

**Publish the live event inside the transaction.** Rejected because listener execution can block or fail while locks are held. Durable delivery requires a future transactional outbox.

## Consequences

The Provider gives one MySQL-backed deployment durable team and membership lifecycle and revision semantics while roles and object grants remain independent. A foreign tenant cannot insert a membership against a locked team row. Soft-deleted teams and revoked membership slots remain addressable. Schema version mismatch fails startup.

## Acceptance criteria

- The plugin supplies the unchanged `ctx.teams` API through `ctx.mysql` and owns no role or object-grant data.
- Team rows persist `tenant_id`; membership rows persist no action columns.
- Kick updates status and revision in one transaction and emits no base-service event before commit.
- A membership insert whose tenant does not own the locked team fails as `tenant-mismatch`.
- Focused keyless tests meet the repository's per-file coverage threshold, while real MySQL verification remains gated by `DSH_MYSQL_TEST_URL`.

## Risks

- MySQL DDL commits independently, so startup can leave version metadata or a table after later schema initialization fails. A subsequent activation deterministically verifies and completes the same version-1 schema.
- A commit failure can leave its outcome unknown to the caller. The Provider reports `provider-unavailable` and never retries a mutation whose commit may have reached the server.
- UUID key order distributes inserts but does not preserve team or membership creation order.

## Verification

The shared Provider suite runs against a stateful MySQL test double. Provider tests pin schema compatibility, the absence of action columns, cross-tenant insert denial, kick rollback, keyset/filter/scope cursor validation, lock order, and storage-error redaction. An environment-gated test using `DSH_MYSQL_TEST_URL` covers concurrent kick revision conflicts.
