# @deepseek-ai/dsh-tenant-authority

English | [中文](README.zh.md)

Cross-tenant deny guard for authority decisions. The service compares a trusted actor scope to the resolved resource tenant, registers resolvers on `ctx.authority`, and returns the same public deny as a missing resource when those tenants differ. It does not store grants, does not compute Effective, and does not read MySQL.

This package is the Service Definition and the decide-entry Consumer. A deployment mounts it as `ctx.tenantAuthority` after `ctx.auth`, `ctx.authority`, and `ctx.tenants`. Product callers use `ctx.tenantAuthority.decide` rather than `ctx.authority.decide`. Authority without this plugin does not apply the not-found rule.

## Public API

| API | Purpose |
|---|---|
| `ctx.tenantAuthority.registerResolver(type, resolver)` | Register the sole resolver on this guard and on `ctx.authority` |
| `ctx.tenantAuthority.match(query)` | Return whether the actor scope matches one resolved tenant |
| `ctx.tenantAuthority.decide(request)` | Decide allow or deny after the tenant check |
| `ctx.tenantAuthority.require(request)` | Require allow or throw the matching deny category |

The request carries a trusted `scope`. Tenant scope names the selected `tenantId`. Platform scope is never treated as tenant membership.

A caller presenting another tenant's valid id receives `unresolved-resource`, the same public deny as a nonexistent id. The deny does not name the other tenant or say that the resource exists.

## Administrator Operations

Mount `ctx.auth`, `ctx.authority`, and `ctx.tenants` first. Register the resource resolver here, register the role and object routes on authority, then decide through this service:

```text
trusted scope + resource pointer
  -> ctx.tenantAuthority.decide
  -> same-tenant membership check
  -> ctx.authority.decide
```

Disposing the `tenantAuthority` fiber unregisters resolvers it forwarded to authority.

## Failure Semantics

| Code | Meaning |
|---|---|
| `invalid-input` | A request, scope, or resolver registration value is malformed |
| `conflict` | A resolver for that resource class is already registered |
| `unresolved-resource` | The resource is missing, the actor is not in the selected tenant, the tenants differ, or the scope is platform |
| `missing-provider` | No resolver is registered for the resource class |
| `provider-unavailable` | Membership lookup or the resolver failed unexpectedly |

Transport adapters decide which internal categories to collapse into one public response. Cross-tenant and not-found must stay the same public category.

## Model Experience

### Tenant-guard evaluation

#### What the model sees

Nothing. `ctx.tenantAuthority.decide` results, membership lookups, and cross-tenant denials are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. Tenant-guard evaluations do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Tenant-guard evaluations do not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **Must be mounted** - `ctx.authority.decide` does not apply this check. Compositions that need the not-found rule must call `ctx.tenantAuthority.decide`.
- **No role or grant storage** - Effective stays in `dsh-authority`.
- **No platform tenant bypass** - platform scope cannot open a tenant resource through this package.
- **No durable audit delivery** - decisions are process-local return values.
