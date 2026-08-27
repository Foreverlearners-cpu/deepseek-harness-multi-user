# 租户授权

[English](tenant-authority.md) | 中文

租户授权子系统是 [`@deepseek-ai/dsh-tenant-authority`](../../packages/identity/tenant-authority/README.md)，它是 Host-only 跨租户守卫和产品 decide 入口。它把可信的操作者 scope 与解析后的资源租户比较，并对外租户有效 id 返回与缺失 id 相同的公开拒绝。Effective、角色目录和对象授权保持独立所有权。

该包是 Service Definition 和 decide 入口 Consumer。它把领域 resolver 注册到 `ctx.authority`。直接调用 `ctx.authority.decide` 的部署不会得到这项检查。

## 隐藏的跨租户拒绝

`decide` 接受带当前 Call、Action 和资源指针的可信 `scope`。租户 scope 要求有效成员。平台 scope 不是租户成员。资源解析后，租户不一致返回 `unresolved-resource`。

Use 与 Delegate 仍由 `dsh-authority` 负责。本包不对这些集合取交。

## 默认故障关闭

缺失 resolver、意外的成员或 resolver 失败，以及意外抛错都会使求值失败。卸载插件 fiber 会注销它转发到 authority 的 resolver。

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
