# Tenant authority

English | [中文](tenant-authority.zh.md)

The tenant-authority subsystem is [`@deepseek-ai/dsh-tenant-authority`](../../packages/identity/tenant-authority/README.md), a Host-only cross-tenant guard and the product decide entry. It compares a trusted actor scope to the resolved resource tenant and returns the same public deny for a foreign valid id as for a missing id. Effective, role catalogs, and object grants remain independent owners.

This package is the Service Definition and the decide-entry Consumer. It registers domain resolvers on `ctx.authority`. A deployment that calls `ctx.authority.decide` directly does not get this check.

## Hidden cross-tenant deny

`decide` accepts a trusted `scope` with the current call, action, and resource pointer. Tenant scope requires an active membership. Platform scope is not tenant membership. After the resource resolves, a tenant mismatch returns `unresolved-resource`.

Use and Delegate stay in `dsh-authority`. This package does not intersect those sets.

## Default fail-closed

Missing resolvers, unexpected membership or resolver failures, and unexpected throws fail the evaluation. Disposing the plugin fiber unregisters resolvers it forwarded to authority.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtenantauthority--tenantauthority"></a>

### `ctx.tenantAuthority` — `TenantAuthority`

Tenant-guard runtime. It compares the trusted actor scope to the resolved resource tenant, registers resolvers on `ctx.authority`, and never computes Effective or treats platform scope as tenant membership.

```ts cordis-catalog
/** Register the sole resolver for one resource class on this guard and authority.
 * @param type - resource class this resolver owns.
 * @param resolver - domain lookup that returns tenant, team, and revision.
 * @returns idempotent disposer that removes this exact registration.
 */
registerResolver(type: ResourceType, resolver: ResourceResolver): () => void

/** Return whether the actor scope matches the resolved resource tenant.
 * @param query - user, trusted scope, and resolved resource tenant.
 * @returns allow when the tenant scope matches and membership is active.
 */
async match(query: TenantScopeQuery): Promise<TenantScopeDecision>

/** Decide whether the request is allowed. Cross-tenant ids deny as unresolved.
 * @param request - current call, action, resource pointer, purpose, and actor scope.
 * @returns allow with the trusted resource, or a deny category.
 */
async decide(request: TenantAuthorityRequest): Promise<TenantAuthorityDecision>

/** Require an allow decision or throw the matching deny category.
 * @param request - current call, action, resource pointer, purpose, and actor scope.
 * @returns trusted resource used for the allow decision.
 */
async require(request: TenantAuthorityRequest): Promise<TrustedResourceRef>
```

Types: [ActionCode](authority.md), [AuthorityDecision](authority.md), [ResourceResolver](authority.md), [ResourceType](authority.md), [TrustedResourceRef](authority.md), [TenantId](tenant-directory.md), [UserId](user-directory.md)

Source: [`packages/identity/tenant-authority/src/index.ts:168`](../../packages/identity/tenant-authority/src/index.ts)
<!-- END GENERATED cordis-surface -->
