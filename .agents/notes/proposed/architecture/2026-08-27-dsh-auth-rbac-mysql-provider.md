# Agent Note: MySQL RBAC policy-source Provider

Status: proposed

English | [中文](2026-08-27-dsh-auth-rbac-mysql-provider.zh.md)

## Problem

The provider-neutral [`dsh-auth-rbac` role route](2026-08-26-dsh-auth-rbac-role-route.md) needs durable multi-process storage for `principal_roles` and `role_action_grants` without moving Effective, object grants, or connection-pool ownership into the role service. Bindings must include `team_id` so one user can hold different roles on different teams. Replacing a role's actions must increment revision so later evaluations cannot reuse the previous set.

## Proposal

Add `@deepseek-ai/dsh-auth-rbac-mysql` as a concrete `RbacPolicySource` over the Host-only `ctx.mysql` connection service. The plugin supplies `ctx.authRbacMysql` for writes, registers itself on `ctx.authRbac`, and owns `dsh_rbac_schema`, `dsh_role_action_grants`, `dsh_principal_roles`, their indexes, SQL, schema version, and storage error mapping. It neither changes `dsh-auth-rbac` nor extends `dsh-mysql`.

Schema version 1 stores one role row per `role_id` with JSON Use and Delegate arrays and a monotonic revision. Replacing those arrays increments revision. Principal bindings use primary key `(user_id, tenant_id, team_id, role_id)` with `active`/`revoked` status. `listPrincipalRoles` matches all three identity fields and `active` only. Revoke updates status and revision in one statement. Re-assigning a revoked slot restores `active` at revision 1.

Writes lock the target row, validate, write, re-read the committed row, and commit. Unexpected SQL and rollback failures become `provider-unavailable`. The source does not call `ctx.tenants` or `ctx.teams`.

## Alternatives considered

**Put SQL in `dsh-auth-rbac`.** Rejected because the Service Definition must remain usable with other storage Providers and must not require Host database connectivity.

**Store role actions on team membership rows.** Rejected because membership usability is a directory fact; expanding a team into per-user grant rows would explode tables. Role actions stay on the role catalog.

**Omit `team_id` from the binding key.** Rejected because the same user would then hold one role set for every team in the tenant, and `evaluate` could not isolate RoleUse(T).

**Join `dsh_team_memberships` on evaluate.** Rejected because kick-to-revoke for membership is owned by `dsh-team`; this Provider revokes the principal-role row and does not read another package's tables.

## Consequences

The Provider gives one MySQL-backed deployment durable team-scoped role bindings and role-action revisions while object grants and Effective remain independent. A user with `runner` on the research team and `viewer` on the operations team cannot leak `plugin:execute` into the operations-team Use set. Schema version mismatch fails startup.

## Acceptance criteria

- The plugin implements `RbacPolicySource`, registers on `ctx.authRbac`, and owns no object-grant data.
- `principal_roles` persist `team_id`; `listPrincipalRoles` never returns another team's roles.
- Replacing a role's actions increments revision and changes the next `evaluate` result.
- The shared `dsh-auth-rbac` contract passes against this Provider.
- Focused keyless tests meet the repository's per-file coverage threshold, while real MySQL verification remains gated by `DSH_MYSQL_TEST_URL`.

## Risks

- MySQL DDL commits independently, so startup can leave version metadata or a table after later schema initialization fails. A subsequent activation deterministically verifies and completes the same version-1 schema.
- A commit failure can leave its outcome unknown to the caller. The Provider reports `provider-unavailable` and never retries a mutation whose commit may have reached the server.
- JSON action arrays require parse validation on read; a malformed stored array is `provider-unavailable`.

## Verification

The shared role-route contract runs against a stateful MySQL test double seeded with the research-team runner and operations-team viewer fixture. Provider tests pin schema compatibility, `team_id` in the binding key, same-user cross-team and cross-tenant isolation, role-revision replacement, revoke, lock-step write failures, and storage-error redaction. An environment-gated test using `DSH_MYSQL_TEST_URL` covers isolation, revision replacement, and revoke on a real server.
