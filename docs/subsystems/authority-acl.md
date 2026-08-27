# Authority ACL

English | [中文](authority-acl.zh.md)

The authority-acl subsystem is [`@deepseek-ai/dsh-authority-acl`](../../packages/identity/authority-acl/README.md), a Host-only object-grant catalog and the authority object-route Provider. It stores grants for `user`, `role`, `team`, `tenant`, and `everyone` subjects and unions ObjectUse or ObjectDelegate on the query team only. Team grants stay one row. Role catalogs, Effective, and MySQL remain independent owners.

This package is the Service Definition, an in-memory policy source, and the object-route Consumer. [`@deepseek-ai/dsh-authority-acl-mysql`](../../packages/identity/authority-acl-mysql/README.md) is the durable MySQL `AclPolicySource`. It owns resource-action-grant rows (including `g:team` subjects and resource revision) and does not compute Effective or expand team grants into user rows.

## Same-team object sets

`evaluate` accepts the authority query's user, tenant, team, resource, and `set`. The policy source returns grant rows for that resource. A team subject matches only when it names the query team and `ctx.teams` reports an active membership. The runtime never unions grants whose team subject is a different team.

Use and Delegate are separate sets. A Use evaluation does not read Delegate actions.

## Default fail-closed

Missing sources, invalid source results, unexpected team-directory failures, and unexpected throws fail the evaluation. Disposing the plugin fiber unregisters the authority object route.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthorityacl--authorityacl"></a>

### `ctx.authorityAcl` — `AuthorityAcl`

Object-route runtime. It unions object-grant actions that match the query team and live subject facts, registers that set on `ctx.authority`, and never computes Effective or reads principal_roles.

```ts cordis-catalog
/** Register the sole policy source used to read object grants.
 * @param source - reader for per-resource grant rows.
 * @returns idempotent disposer that removes this exact registration.
 */
registerSource(source: AclPolicySource): () => void

/** Register the sole role-fact source used to match role-subject grants.
 * @param source - reader for roles the user currently holds on team T.
 * @returns idempotent disposer that removes this exact registration.
 */
registerRoleFacts(source: AclRoleFactSource): () => void

/** Return ObjectUse(T) or ObjectDelegate(T) for the query team only.
 * @param query - resolved user, tenant, team, action, resource, and set.
 * @returns union of matching object-grant actions on that one team.
 */
async evaluate(query: AuthorityRouteQuery): Promise<AuthorityRouteResult>
```

Types: [ActionCode](authority.md), [AuthorityRouteQuery](authority.md), [AuthorityRouteResult](authority.md), [TeamId](team-directory.md), [TenantId](tenant-directory.md), [UserId](user-directory.md)

Source: [`packages/identity/authority-acl/src/index.ts:202`](../../packages/identity/authority-acl/src/index.ts)
<!-- END GENERATED cordis-surface -->
