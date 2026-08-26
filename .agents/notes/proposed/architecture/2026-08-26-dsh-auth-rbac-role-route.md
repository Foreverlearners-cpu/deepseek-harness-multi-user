# Agent Note: dsh-auth-rbac role route

Status: proposed

English | [中文](2026-08-26-dsh-auth-rbac-role-route.zh.md)

## Problem

Authorization needs the set of actions a user may use or delegate on one team from the roles bound to that user on that team. Tenant membership does not name a role. Team membership does not name actions. `dsh-authority` intersects two routes and must not store role rows.

Binding a role only to a tenant would give every team in that tenant the same actions. Letting RBAC compute ALLOW or DENY would move the merge rule out of `dsh-authority` and invite a cross-team union. Reading object grants here would mix the two routes.

The repository needs a provider-neutral role catalog and role-route Provider before MySQL or ACL. The package must own team-scoped principal-role bindings, RoleUse / RoleDelegate aggregation, and registration on `ctx.authority`. It must not compute Effective.

## Proposal

Add `@deepseek-ai/dsh-auth-rbac` as the role catalog and the authority `role` route. A deployment mounts exactly one instance as `ctx.authRbac` after `ctx.authority`. The package injects `authority` only to call `registerRoute('role', …)`. It does not call `decide` or `require`, and it does not call `ctx.tenants` or `ctx.teams`.

`principal_roles` is `(user, tenant, team, role)`. The same user may hold different roles on different teams. `RbacPolicySource` returns the role ids for that one triple and the Use / Delegate sets for each role. This package unions those sets in process:

```text
RoleUse(T) = ⋃ use(role) for each role bound to (user, tenant, T)
RoleDelegate(T) = ⋃ delegate(role) for each role bound to (user, tenant, T)
```

`T` is the team on the authority query. The runtime never unions roles from other teams. Use evaluations read `use` only. That rule is not a `Config` field.

`MemoryRbacPolicySource` is the in-process source. Later `dsh-auth-rbac-mysql` implements the same reader. Missing source, invalid source data, and an undefined bound role are `provider-unavailable`. Disposing the plugin fiber unregisters the role route.

## Decision inputs

| Value | Owner |
| --- | --- |
| `AuthorityRouteQuery` | `dsh-authority` after it resolves the resource team. |
| Role ids on `(user, tenant, T)` | `RbacPolicySource.listPrincipalRoles`. |
| Use / Delegate sets | `RbacPolicySource.listRoleActions`. |
| Effective | `dsh-authority`; this package does not intersect with object grants. |

The role route does not expand team membership into per-user grants and does not decide ALLOW or DENY.

## Alternatives considered

**Bind roles only to a tenant.** Rejected because the same user can be a runner on research and a viewer on operations. A tenant-only role would leak execute onto the operations team.

**Let RBAC compute ALLOW or DENY.** Rejected because the merge rule belongs to `dsh-authority`. This package only reports the role set on one team.

**Union every team the user belongs to.** Rejected because a research-team runner would add execute to an operations-team evaluation. Same-team aggregation is the product rule.

**Read object grants or compute Effective here.** Rejected because the object route is an independent fact. Mixing the routes would let RBAC invent the intersection.

**Read MySQL from this package.** Rejected because the Service Definition must stay provider-neutral. Storage belongs to later `dsh-auth-rbac-mysql`.

## Acceptance criteria

- The package defines `registerSource`, `evaluate`, `RbacPolicySource`, branded `RoleId`, an in-memory source, and a fixture contract suite.
- The package does not import authorization storage, Session, transport, database, or cache packages, and opens no external resource.
- Research-team `runner={plugin:read, plugin:execute}` plus operations-team `viewer={plugin:read}` returns `{plugin:read}` when the query team is operations.
- Use evaluations do not read Delegate sets. Delegate evaluations do not read Use sets.
- Live source updates are visible on the next `evaluate`. Disposing the plugin fiber unregisters the authority role route.
- Existing Session, Agent, authentication, tenant-directory, team-directory, and authority behavior remains unchanged when only `dsh-auth-rbac` is added.
- ACL and MySQL Providers remain separate follow-up packages.

## Risks

- Using only the query team as `T` cannot yet honor a role whose scope is a different team than the resource home team. A later change must keep same-team aggregation and must not introduce a cross-team union.
- An undefined bound role fails the whole evaluation. Transport Consumers must not map that category to a public signal that enumerates role names.
- Injecting `ctx.authority` couples load order to the decision runtime. That is required to register the role route, and a missing authority service fails at plugin load.
