# @deepseek-ai/dsh-authority

English | [中文](README.zh.md)

Host authorization decision runtime. The service catalogues actions, accepts trusted identity from `dsh-auth`, resolves a resource's tenant and team through a domain resolver, asks the role and object routes for their Use or Delegate sets on that one team, and intersects those sets. It does not store roles, grants, or memberships, and it does not read MySQL.

This package is the Service Definition and decision engine. A deployment mounts it as `ctx.authority` after `ctx.auth`. Later `dsh-auth-rbac` and `dsh-authority-acl` register the two routes.

## Public API

| API | Purpose |
|---|---|
| `ctx.authority.registerAction(definition)` | Catalogue one action and the resource class it may target; returns a disposer |
| `ctx.authority.registerRoute(route, provider)` | Register the sole `role` or `object` Provider; returns a disposer |
| `ctx.authority.registerResolver(type, resolver)` | Register the sole resolver for one resource class; returns a disposer |
| `ctx.authority.decide(request)` | Return allow or a deny category without throwing for policy failures |
| `ctx.authority.require(request)` | Return the trusted resource on allow, or throw the deny category |

`AuthorityRequest` is a current `AuthenticatedCall`, a catalogued action, and an untrusted `{ type, id }` resource pointer. The client cannot supply the tenant or team used for the decision. Optional `purpose` is `use` or `delegate` and defaults to `use`.

## Same-team intersection

After the resolver returns a trusted resource, both route Providers receive that resource's `tenantId` and `teamId` as `T`. Each Provider returns the Use or Delegate action set for that one team. The runtime allows the request only when the requested action is in both sets:

```text
Effective(T) = RoleSet(user, T) ∩ ObjectSet(resource, T)
```

The runtime never unions sets from different teams and then intersects. A research-team role cannot combine with an operations-team object grant. That merge rule is a security invariant, not a `Config` field.

Use and Delegate are separate sets. A Use decision asks both Providers for `set: 'use'` only. Delegate actions never enter a Use decision.

## Default deny

The runtime denies when the call is not current, the principal is not a user, the action is unknown or targets the wrong resource class, the resource cannot be resolved, either route Provider or the resolver is missing, either set lacks the action, or a Provider returns invalid data or throws. Disposing a route Provider returns the runtime to fail-closed for that route.

`decide()` maps those cases to a deny category. It throws only `invalid-input`. `require()` throws `AuthorityError` with the deny category.

## Implementing a route Provider

A route Provider implements `evaluate(query)` and returns `{ actions }` for the supplied user, tenant, team, action, trusted resource, and `set`. It does not decide ALLOW or DENY and must not mix teams inside one result. Register the Provider through `ctx.effect()` so the disposer follows the plugin fiber.

A resource resolver implements `resolve(ref)` and returns `type`, `id`, `tenantId`, `teamId`, and `revision`, or `undefined` when the pointer is unknown. The returned type and id must match the request pointer.

The shared suite in `tests/contract.ts` is the normative decision contract. Fixture Providers in that suite are tests only.

## Administrator Operations

The caller authenticates first. A typical Use check follows this order:

```text
transport credential
  -> dsh-auth mints AuthenticatedCall
  -> domain resolver records tenant and team
  -> ctx.authority.require({ call, action, resource })
  -> later RBAC and ACL Providers supply the two per-team sets
```

Operation context on later storage packages is not proof of authorization.

## Failure Semantics

| Code | Meaning |
|---|---|
| `invalid-input` | A purpose, route, resource pointer, or registration value is malformed |
| `conflict` | An action, route, or resolver is already registered |
| `unauthenticated` | The call was not issued by the live `ctx.auth` runtime |
| `unknown-action` | The action is unregistered or does not target the resource class |
| `unresolved-resource` | The resolver is present and returned no trusted resource |
| `missing-provider` | The resolver or either route Provider is unregistered |
| `insufficient-permission` | The same-team intersection does not contain the action, or the principal is not a user |
| `provider-unavailable` | A resolver or route Provider threw or returned an invalid result |

Transport adapters decide which internal categories to collapse into one public response.

## Model Experience

### Authorization decision

#### What the model sees

Nothing. `ctx.authority.decide` results, action catalogues, and trusted resource facts are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. Authorization decisions do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Authorization decisions do not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **No role or grant storage** - `dsh-auth-rbac` and `dsh-authority-acl` own those records and the per-team sets they report.
- **No tenant-directory or team-directory lookup** - this service accepts branded ids from the resolver and does not call `ctx.tenants` or `ctx.teams`.
- **No cross-tenant rule** - a later `dsh-tenant-authority` Consumer can deny when the actor and resource tenants differ.
- **No grant-subject iteration** - the decision uses the resolved resource team as `T`; walking additional teams that received a grant is deferred until ACL needs it.
- **No durable audit delivery** - decisions are process-local return values; a durable audit stream requires a later outbox.
