# @deepseek-ai/dsh-authority-acl

English | [中文](README.zh.md)

Object-grant catalog and the authority object-route Provider. The service reads grant rows from an `AclPolicySource`, unions ObjectUse or ObjectDelegate actions that match the query team and live subject facts, and registers the result on `ctx.authority`. It does not store `principal_roles`, does not compute Effective, and does not read MySQL.

This package is the Service Definition, an in-memory policy source, and the object-route Consumer. A deployment mounts it as `ctx.authorityAcl` after `ctx.authority` and `ctx.teams`. [`dsh-authority-acl-mysql`](../authority-acl-mysql/README.md) implements `AclPolicySource`.

## Public API

| API | Purpose |
|---|---|
| `ctx.authorityAcl.registerSource(source)` | Register the sole grant source; returns a disposer |
| `ctx.authorityAcl.registerRoleFacts(source)` | Register the sole role-fact source used to match role subjects |
| `ctx.authorityAcl.evaluate(query)` | Return ObjectUse(T) or ObjectDelegate(T) for the query team only |
| `MemoryAclPolicySource` | Process-local object grants |
| `aclSubjectRef(subject)` | Encode a subject as `g:team-rd`, `u:user-red`, `r:runner`, `t:tenant-1`, or `everyone` |

Subjects are `user`, `role`, `team`, `tenant`, and `everyone`. A team grant is stored as `g:team-rd`. Adding or kicking members does not copy or delete that row. Membership is read from `ctx.teams` at evaluate time.

Use and Delegate stay separate. A Use evaluation unions `use` actions only. Delegate actions never enter a Use result.

## Same-team object sets

After `dsh-authority` resolves a resource team `T`, this Provider returns:

```text
ObjectUse(T) = ⋃ use(grant) for each grant on the resource whose subject matches T
ObjectDelegate(T) = ⋃ delegate(grant) for each grant on the resource whose subject matches T
```

A team subject matches only when the grant names `T` and `ctx.teams` reports an active membership. A research-team execute grant does not enter an operations-team result. This package does not intersect those sets with role actions. `dsh-authority` owns Effective.

## Administrator Operations

Mount `ctx.auth`, `ctx.authority`, and `ctx.teams` first. Register a policy source, then let authority ask the object route:

```text
AclPolicySource rows
  -> ctx.authorityAcl.evaluate({ user, tenant, team T, resource, set })
  -> ctx.authority.registerRoute('object', …)
  -> ctx.authority.decide / require
```

Disposing the `authorityAcl` fiber unregisters the object route and returns authority to fail-closed for that route. Updating the memory source or kicking a member is visible on the next `evaluate` without remounting.

## Failure Semantics

| Code | Meaning |
|---|---|
| `invalid-input` | A query, subject, or source registration value is malformed |
| `conflict` | A policy source or role-fact source is already registered |
| `provider-unavailable` | A source is missing, threw, returned invalid data, or team lookup failed unexpectedly |

Transport adapters decide which internal categories to collapse into one public response.

## Model Experience

### Object-grant evaluation

#### What the model sees

Nothing. `ctx.authorityAcl.evaluate` results, grant rows, and membership lookups are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. Object-grant evaluations do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Object-grant evaluations do not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **MySQL persistence is a separate package** - [`dsh-authority-acl-mysql`](../authority-acl-mysql/README.md) owns `resource_action_grants`, resource revisions, and durable team subjects.
- **No role catalog** - role-subject matching asks a registered fact source; this package does not read `principal_roles`.
- **No Effective computation** - same-team intersection stays in `dsh-authority`.
- **No tenant-directory lookup** - tenant subjects match the query tenant id only.
- **No durable audit delivery** - evaluations are process-local return values.
