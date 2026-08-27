# Agent Note: MySQL ACL policy-source Provider

Status: proposed

English | [中文](2026-08-27-dsh-authority-acl-mysql-provider.zh.md)

## Problem

The provider-neutral [`dsh-authority-acl` object route](2026-08-27-dsh-authority-acl-object-route.md) needs durable multi-process storage for `resource_action_grants` without moving Effective, role catalogs, or connection-pool ownership into the object service. A team subject must stay one `g:team-rd` row. Writes that record a delegated grant must not call `decide` in this package. Grants for one resource revision must not mix with another resource or revision.

## Proposal

Add `@deepseek-ai/dsh-authority-acl-mysql` as a concrete `AclPolicySource` over the Host-only `ctx.mysql` connection service. The plugin supplies `ctx.authorityAclMysql` for writes, registers itself on `ctx.authorityAcl`, and owns `dsh_acl_schema`, `dsh_resource_action_grants`, indexes, SQL, schema version, and storage error mapping. It neither changes `dsh-authority-acl` nor extends `dsh-mysql`.

Schema version 1 stores one row per `(resource_type, resource_id, resource_revision, subject_ref)` with JSON Use and Delegate arrays, `active`/`revoked` status, and a monotonic row revision. A team subject is stored as `g:team-rd`. `listGrants` returns active rows for a resource type and id. `listGrantsAt` returns active rows for one resource revision.

`grant` and `revoke` lock the target slot, write, re-read, and commit. They do not call `ctx.authority.decide` or `require`. Unexpected SQL and rollback failures become `provider-unavailable`. The source does not call `ctx.teams` and does not expand a team grant into per-user rows.

## Alternatives considered

**Put SQL in `dsh-authority-acl`.** Rejected because the Service Definition must remain usable with other storage Providers and must not require Host database connectivity.

**Copy a team grant onto each user row.** Rejected because join and kick would rewrite ACL and the table would grow with membership. The grant stays `g:team-rd`.

**Call `decide` inside `grant`.** Rejected because Effective and allow/deny belong to `dsh-authority`. This package persists an already-authorized write.

**Key grants only by resource type and id.** Rejected because two revisions of the same resource would share one slot and `listGrantsAt` could not isolate them.

## Consequences

The Provider gives one MySQL-backed deployment durable object grants keyed by resource revision while role catalogs and Effective remain independent. A research-team execute grant stays one row after members join. Schema version mismatch fails startup.

## Acceptance criteria

- The plugin implements `AclPolicySource`, registers on `ctx.authorityAcl`, and owns no `principal_roles` data.
- A team grant persists as one `g:team-*` row and is not copied per member.
- `listGrantsAt` returns only the requested resource revision and does not return another resource.
- `grant` does not call `ctx.authority.decide`.
- The shared `dsh-authority-acl` contract passes against this Provider.
- Focused keyless tests meet the repository's per-file coverage threshold, while real MySQL verification remains gated by `DSH_MYSQL_TEST_URL`.

## Risks

- MySQL DDL commits independently, so startup can leave version metadata or a table after later schema initialization fails. A subsequent activation deterministically verifies and completes the same version-1 schema.
- A commit failure can leave its outcome unknown to the caller. The Provider reports `provider-unavailable` and never retries a mutation whose commit may have reached the server.
- JSON action arrays require parse validation on read; a malformed stored array is `provider-unavailable`.

## Verification

The shared object-route contract runs against a stateful MySQL test double seeded with one `g:team-rd` execute grant. Provider tests pin schema compatibility, the single team-subject row, resource and revision isolation, no `decide` on write, revoke, lock-step write failures, and storage-error redaction. An environment-gated test using `DSH_MYSQL_TEST_URL` covers the same isolation on a real server.
