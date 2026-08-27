# Agent Note: dsh-authority-acl object route

Status: proposed

English | [中文](2026-08-27-dsh-authority-acl-object-route.zh.md)

## Problem

Authorization needs the set of actions a resource allows one caller to use or delegate on the resource's team. Role bindings do not name a resource. `dsh-authority` intersects two routes and must not store grant rows.

Copying a team grant onto each member row explodes storage and makes join and kick rewrite ACL. Letting ACL compute ALLOW or DENY would move the merge rule out of `dsh-authority` and invite a cross-team union. Reading `principal_roles` here would mix the two routes.

The repository needs a provider-neutral object-grant catalog and object-route Provider before MySQL. The package must own resource-action grants, ObjectUse / ObjectDelegate aggregation, and registration on `ctx.authority`. It must not compute Effective.

## Proposal

Add `@deepseek-ai/dsh-authority-acl` as the object-grant catalog and the authority `object` route. A deployment mounts exactly one instance as `ctx.authorityAcl` after `ctx.authority` and `ctx.teams`. The package injects `authority` to call `registerRoute('object', …)` and injects `teams` to resolve live membership. It does not call `decide` or `require`, and it does not read `principal_roles`.

Grant subjects are `user`, `role`, `team`, `tenant`, and `everyone`. A team grant is stored as `g:team-rd` and stays one row. Join and kick do not copy or delete that row. `AclPolicySource` returns grants for one resource. This package unions those sets in process:

```text
ObjectUse(T) = ⋃ use(grant) for each grant on the resource whose subject matches T
ObjectDelegate(T) = ⋃ delegate(grant) for each grant on the resource whose subject matches T
```

A team subject matches only when it names the query team `T` and `ctx.teams.requireActiveMembership` reports an active pair. A research-team execute grant does not enter an operations-team result. After a kick, the same user no longer matches `g:team-rd`. Role-subject matching asks a registered fact source; this package does not own that table.

`MemoryAclPolicySource` is the in-process source. Later `dsh-authority-acl-mysql` implements the same reader. Missing source, invalid source data, and unexpected team lookup failures are `provider-unavailable`. Disposing the plugin fiber unregisters the object route.

## Decision inputs

| Value | Owner |
| --- | --- |
| `AuthorityRouteQuery` | `dsh-authority` after it resolves the resource team. |
| Grant rows on one resource | `AclPolicySource.listGrants`. |
| Live team membership | `ctx.teams.requireActiveMembership`. |
| Roles on `(user, tenant, T)` | `AclRoleFactSource.listRolesOnTeam`. |
| Effective | `dsh-authority`; this package does not intersect with role actions. |

The object route does not expand team membership into per-user grants and does not decide ALLOW or DENY.

## Alternatives considered

**Copy a team grant onto each user row.** Rejected because join and kick would rewrite ACL and the table would grow with membership. The grant stays `g:team-rd`; membership is read from the team service.

**Let ACL compute ALLOW or DENY.** Rejected because the merge rule belongs to `dsh-authority`. This package only reports the object set on one team.

**Union every team the user belongs to.** Rejected because a research-team execute grant would appear when the query team is operations. Same-team aggregation is the product rule.

**Read principal_roles or compute Effective here.** Rejected because the role route is an independent fact. Mixing the routes would let ACL invent the intersection.

**Read MySQL from this package.** Rejected because the Service Definition must stay provider-neutral. Storage belongs to later `dsh-authority-acl-mysql`.

## Acceptance criteria

- The package defines `registerSource`, `registerRoleFacts`, `evaluate`, `AclPolicySource`, branded subject refs, an in-memory source, and a fixture contract suite.
- The package does not import authorization storage, Session, transport, database, or cache packages, and opens no external resource.
- A resource granted `plugin:execute` to `g:team-rd` does not add that action when the query team is operations.
- After the user is kicked from the research team, evaluate on that team no longer matches `g:team-rd`, and the grant row is unchanged.
- Use evaluations do not read Delegate sets. Delegate evaluations do not read Use sets.
- Live source and membership updates are visible on the next `evaluate`. Disposing the plugin fiber unregisters the authority object route.
- Existing Session, Agent, authentication, tenant-directory, team-directory, authority, and RBAC behavior remains unchanged when only `dsh-authority-acl` is added.
- MySQL Providers remain a separate follow-up package.

## Risks

- Using only the query team as `T` cannot yet honor a team grant whose subject is a different team than the resource home team. A later change must keep same-team aggregation and must not introduce a cross-team union.
- An unexpected team-directory failure fails the whole evaluation. Transport Consumers must not map that category to a public signal that enumerates grant subjects.
- Injecting `ctx.authority` and `ctx.teams` couples load order to the decision runtime and the team directory. That is required to register the object route and to resolve `g:team-*` subjects live.
