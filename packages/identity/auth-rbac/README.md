# @deepseek-ai/dsh-auth-rbac

English | [中文](README.zh.md)

Team-scoped role catalog and the authority role-route Provider. The service reads `principal_roles = (user, tenant, team, role)` from a `RbacPolicySource`, unions that user's RoleUse or RoleDelegate actions on the query team only, and registers the result on `ctx.authority`. It does not store object grants, does not compute Effective, and does not read MySQL.

This package is the Service Definition, an in-memory policy source, and the role-route Consumer. A deployment mounts it as `ctx.authRbac` after `ctx.authority`. Later `dsh-auth-rbac-mysql` implements `RbacPolicySource`.

## Public API

| API | Purpose |
|---|---|
| `ctx.authRbac.registerSource(source)` | Register the sole policy source; returns a disposer |
| `ctx.authRbac.evaluate(query)` | Return RoleUse(T) or RoleDelegate(T) for the query team only |
| `MemoryRbacPolicySource` | Process-local role definitions and principal-role bindings |

The same user may hold different roles on different teams. `evaluate` asks the source for bindings that match `userId`, `tenantId`, and `teamId` together. It never unions roles from other teams.

Use and Delegate stay separate. A Use evaluation unions `use` actions only. Delegate actions never enter a Use result.

## Same-team role sets

After `dsh-authority` resolves a resource team `T`, this Provider returns:

```text
RoleUse(T) = ⋃ use(role) for each role bound to (user, tenant, T)
RoleDelegate(T) = ⋃ delegate(role) for each role bound to (user, tenant, T)
```

A research-team `runner` with `{plugin:read, plugin:execute}` does not add `plugin:execute` to an operations-team `viewer` result of `{plugin:read}`. This package does not intersect those sets with object grants. `dsh-authority` owns Effective.

## Administrator Operations

Mount `ctx.auth` and `ctx.authority` first. Register a policy source, then let authority ask the role route:

```text
RbacPolicySource rows
  -> ctx.authRbac.evaluate({ user, tenant, team T, set })
  -> ctx.authority.registerRoute('role', …)
  -> ctx.authority.decide / require
```

Disposing the `authRbac` fiber unregisters the role route and returns authority to fail-closed for that route. Updating the memory source is visible on the next `evaluate` without remounting.

## Failure Semantics

| Code | Meaning |
|---|---|
| `invalid-input` | A query, role id, or source registration value is malformed |
| `conflict` | A policy source is already registered |
| `provider-unavailable` | The source is missing, threw, returned invalid data, or named an undefined role |

Transport adapters decide which internal categories to collapse into one public response.

## Model Experience

### Role evaluation

#### What the model sees

Nothing. `ctx.authRbac.evaluate` results, role bindings, and role catalogs are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. Role evaluations do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Role evaluations do not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **No production store** - `dsh-auth-rbac-mysql` owns `principal_roles`, role-action grants, revisions, and kick-to-revoke.
- **No object grants** - resource ACL rows belong to `dsh-authority-acl`.
- **No Effective computation** - same-team intersection stays in `dsh-authority`.
- **No tenant-directory or team-directory lookup** - this service accepts branded ids from the authority query and does not call `ctx.tenants` or `ctx.teams`.
- **No durable audit delivery** - evaluations are process-local return values.
