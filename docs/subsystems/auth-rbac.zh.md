# 认证 RBAC

[English](auth-rbac.md) | 中文

认证 RBAC 子系统是 [`@deepseek-ai/dsh-auth-rbac`](../../packages/identity/auth-rbac/README.md)，它是 Host-only 角色目录和 authority 角色路线 Provider。它把角色绑到 `(user, tenant, team)`，并只在查询团队上合并 RoleUse 或 RoleDelegate。对象授权、Effective 和 MySQL 保持独立所有权。

该包是 Service Definition、内存策略源，以及角色路线 Consumer。后续 MySQL 实现 `RbacPolicySource`。MySQL 包不属于这里。

## 同一团队角色集合

`evaluate` 接受 authority 查询中的用户、租户、团队和 `set`。策略源返回该三元组上的角色 id，以及每个角色的 Use / Delegate 集合。运行时合并所请求的集合，不会合并其他团队的角色。

Use 与 Delegate 是两套集合。Use 求值不读取 Delegate Action。

## 默认故障关闭

缺失源、无效源结果、未定义的已绑定角色和意外抛错都会使求值失败。卸载插件 fiber 会注销 authority 角色路线。

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
