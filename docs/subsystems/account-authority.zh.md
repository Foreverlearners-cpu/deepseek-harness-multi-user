# 账号授权

[English](account-authority.md) | 中文

账号授权子系统是 [`@deepseek-ai/dsh-account-authority`](../../packages/identity/account-authority/README.md)，它是 Host-only Consumer，注册唯一的 `AccountAdminAuthorizer`。它断言当前 Call，把管理员操作映射为 `account:*`，并在该用户的唯一团队上要求该 Action。Effective、角色目录、对象授权和账号生命周期保持独立所有权。

本包不保存授权，也不改动 `dsh-account` 流程。没有本插件的组合仍让管理员方法故障关闭。

## 唯一团队解析

`authorize` 接受账号请求中的操作者、Action 和可选 target。`create` 使用操作者用户 id。其余操作要求 `target`。`account` resolver 列出有效租户与团队成员，仅在恰好存在一个 `(tenant, team)` 对时返回可信资源。

Use 与 Delegate 仍由 `dsh-authority` 负责。本包不对这些集合取交。

## 默认故障关闭

缺失 authorizer、require 拒绝、无法解析唯一团队，以及意外的成员失败都会使管理员操作失败。卸载插件 fiber 会注销 authorizer、resolver 和已登记 Action。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccountauthority--accountauthority"></a>

### `ctx.accountAuthority` — `AccountAuthority`

Account-administration wiring. It registers the unique authorizer, catalogues `account:*` actions, resolves an account resource to the user's unique team, and never computes Effective or stores grants.

```ts cordis-catalog
/** Assert the actor is current, then require the mapped account action on the unique team.
 * @param request - current actor, administrator action, and optional target user.
 */
async authorize(request: AccountAdminAuthorizationRequest): Promise<void>
```

Types: [AccountAdminAuthorizationRequest](authentication.md)

Source: [`packages/identity/account-authority/src/index.ts:126`](../../packages/identity/account-authority/src/index.ts)
<!-- END GENERATED cordis-surface -->
