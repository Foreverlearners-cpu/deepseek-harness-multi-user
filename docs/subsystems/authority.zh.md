# 授权

[English](authority.md) | 中文

授权子系统是 [`@deepseek-ai/dsh-authority`](../../packages/identity/authority/README.md)，它是 Host-only 决策运行时：登记 Action，解析资源的租户和团队，并对角色路线与对象路线给出的按团队 Use 或 Delegate 集合取交。认证、成员目录、角色存储和对象授权保持独立所有权。

该包是 Service Definition 和合并引擎。后续 RBAC 和 ACL Provider 注册两条路线。MySQL 包不属于这里。

## 同一团队交差

`decide` 和 `require` 接受当前的 `AuthenticatedCall`、已登记 Action，以及不可信的 `{ type, id }` 指针。领域 `ResourceResolver` 返回可信的租户、团队和 revision。两条路线的 Provider 都按这一个团队求值。只有 Action 同时出现在两个返回集合中，运行时才允许。它不会合并不同团队的集合。

Use 与 Delegate 是两套集合。Use 决策不读取 Delegate Action。

## 默认拒绝

缺失路线 Provider 或 resolver、未知 Action、无法解析的资源、非当前调用、非用户主体、空交集，以及无效 Provider 结果都是拒绝。卸载路线 Provider 后，该路线回到故障关闭。

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
