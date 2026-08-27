# 授权 ACL

[English](authority-acl.md) | 中文

授权 ACL 子系统是 [`@deepseek-ai/dsh-authority-acl`](../../packages/identity/authority-acl/README.md)，它是 Host-only 对象授权目录和 authority 对象路线 Provider。它为 `user`、`role`、`team`、`tenant` 和 `everyone` 主体保存授权，并只在查询团队上合并 ObjectUse 或 ObjectDelegate。团队授权保持一行。角色目录、Effective 和 MySQL 保持独立所有权。

该包是 Service Definition、内存策略源，以及对象路线 Consumer。[`@deepseek-ai/dsh-authority-acl-mysql`](../../packages/identity/authority-acl-mysql/README.md) 是持久 MySQL `AclPolicySource`。它拥有资源-Action 授权行（含 `g:team` 主体和 resource revision），不计算 Effective，也不把团队授权展开成用户行。

## 同一团队对象集合

`evaluate` 接受 authority 查询中的用户、租户、团队、资源和 `set`。策略源返回该资源上的授权行。团队主体仅在点名查询团队、且 `ctx.teams` 报告成员仍有效时匹配。运行时不会合并团队主体属于其他团队的授权。

Use 与 Delegate 是两套集合。Use 求值不读取 Delegate Action。

## 默认故障关闭

缺失源、无效源结果、意外的团队目录失败和意外抛错都会使求值失败。卸载插件 fiber 会注销 authority 对象路线。

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
