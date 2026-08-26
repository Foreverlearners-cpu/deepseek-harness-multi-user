# Authority

English | [中文](authority.zh.md)

The authority subsystem is [`@deepseek-ai/dsh-authority`](../../packages/identity/authority/README.md), a Host-only decision runtime that catalogues actions, resolves a resource's tenant and team, and intersects per-team Use or Delegate sets from the role and object routes. Authentication, membership directories, role storage, and object grants remain independent owners.

This package is the Service Definition and merge engine. Later RBAC and ACL Providers register the two routes. A MySQL package will not belong here.

## Same-team intersection

`decide` and `require` accept a current `AuthenticatedCall`, a catalogued action, and an untrusted `{ type, id }` pointer. A domain `ResourceResolver` returns the trusted tenant, team, and revision. Both route Providers evaluate that one team. The runtime allows the action only when it appears in both returned sets. It never unions sets from different teams.

Use and Delegate are separate sets. A Use decision does not read Delegate actions.

## Default deny

Missing route Providers or resolvers, unknown actions, unresolved resources, non-current calls, non-user principals, empty intersections, and invalid Provider results are deny. Disposing a route Provider returns that route to fail-closed.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthority--authority"></a>

### `ctx.authority` — `Authority`

Authorization runtime. Route Providers report per-team Use or Delegate sets; this service intersects those sets on the resolved resource team and never unions teams.

```ts cordis-catalog
/** Register one catalogued action. Duplicate actions fail with conflict.
 * @param definition - action and the resource class it may target.
 * @returns idempotent disposer that removes this exact registration.
 */
registerAction(definition: ActionDefinition): () => void

/** Register the sole Provider for one authorization route.
 * @param route - `role` or `object`.
 * @param provider - evaluator that returns the Use or Delegate set on one team.
 * @returns idempotent disposer that removes this exact registration.
 */
registerRoute(route: AuthorityRoute, provider: AuthorityRouteProvider): () => void

/** Register the sole resolver for one resource class.
 * @param type - resource class this resolver owns.
 * @param resolver - domain lookup that returns tenant, team, and revision.
 * @returns idempotent disposer that removes this exact registration.
 */
registerResolver(type: ResourceType, resolver: ResourceResolver): () => void

/** Decide whether the request is allowed. Policy failures are deny, not throws.
 * @param request - current call, action, untrusted resource pointer, and purpose.
 * @returns allow with the trusted resource, or a deny category.
 */
async decide(request: AuthorityRequest): Promise<AuthorityDecision>

/** Require an allow decision or throw the matching deny category.
 * @param request - current call, action, untrusted resource pointer, and purpose.
 * @returns trusted resource used for the allow decision.
 */
async require(request: AuthorityRequest): Promise<TrustedResourceRef>
```

Types: [AuthenticatedCall](authentication.md), [TeamId](team-directory.md), [TenantId](tenant-directory.md), [UserId](user-directory.md)

Source: [`packages/identity/authority/src/index.ts:177`](../../packages/identity/authority/src/index.ts)
<!-- END GENERATED cordis-surface -->
