# Account authority

English | [中文](account-authority.zh.md)

The account-authority subsystem is [`@deepseek-ai/dsh-account-authority`](../../packages/identity/account-authority/README.md), a Host-only Consumer that registers the unique `AccountAdminAuthorizer`. It asserts the current call, maps administrator actions to `account:*`, and requires that action on the user's unique team. Effective, role catalogs, object grants, and account lifecycle remain independent owners.

This package does not store grants and does not change `dsh-account` flows. A composition without this plugin keeps administrator methods fail-closed.

## Unique-team resolve

`authorize` accepts the account request's actor, action, and optional target. `create` uses the actor user id. Other actions require `target`. The `account` resolver lists active tenant and team memberships and returns a trusted resource only when exactly one `(tenant, team)` pair exists.

Use and Delegate stay in `dsh-authority`. This package does not intersect those sets.

## Default fail-closed

A missing authorizer, a require deny, an unresolved unique team, and unexpected membership failures fail the administrator action. Disposing the plugin fiber unregisters the authorizer, resolver, and catalogued actions.

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
