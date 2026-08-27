# Auth RBAC

English | [中文](auth-rbac.zh.md)

The auth-rbac subsystem is [`@deepseek-ai/dsh-auth-rbac`](../../packages/identity/auth-rbac/README.md), a Host-only role catalog and the authority role-route Provider. It binds roles to `(user, tenant, team)` and unions RoleUse or RoleDelegate on the query team only. Object grants, Effective, and MySQL remain independent owners.

This package is the Service Definition, an in-memory policy source, and the role-route Consumer. [`@deepseek-ai/dsh-auth-rbac-mysql`](../../packages/identity/auth-rbac-mysql/README.md) is the durable MySQL `RbacPolicySource`. It owns principal-role rows (including `team_id`), role-action grants, and revisions; it does not compute Effective or store object grants.

## Same-team role sets

`evaluate` accepts the authority query's user, tenant, team, and `set`. The policy source returns role ids for that one triple and the Use / Delegate sets for each role. The runtime unions the requested set and never unions roles from other teams.

Use and Delegate are separate sets. A Use evaluation does not read Delegate actions.

## Default fail-closed

Missing sources, invalid source results, undefined bound roles, and unexpected throws fail the evaluation. Disposing the plugin fiber unregisters the authority role route.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthrbac--authrbac"></a>

### `ctx.authRbac` — `AuthRbac`

Role-route runtime. It unions role actions for one user on the query team only, registers that set on `ctx.authority`, and never computes Effective or reads object grants.

```ts cordis-catalog
/** Register the sole policy source used to read roles and bindings.
 * @param source - reader for role definitions and team-scoped principal bindings.
 * @returns idempotent disposer that removes this exact registration.
 */
registerSource(source: RbacPolicySource): () => void

/** Return RoleUse(T) or RoleDelegate(T) for the query team only.
 * @param query - resolved user, tenant, team, action, resource, and set.
 * @returns union of matching role actions on that one team.
 */
async evaluate(query: AuthorityRouteQuery): Promise<AuthorityRouteResult>
```

Types: [ActionCode](authority.md), [AuthorityRouteQuery](authority.md), [AuthorityRouteResult](authority.md), [TeamId](team-directory.md), [TenantId](tenant-directory.md), [UserId](user-directory.md)

Source: [`packages/identity/auth-rbac/src/index.ts:112`](../../packages/identity/auth-rbac/src/index.ts)
<!-- END GENERATED cordis-surface -->
