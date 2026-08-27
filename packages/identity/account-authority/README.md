# @deepseek-ai/dsh-account-authority

English | [中文](README.zh.md)

Account-administration authorizer that wires `ctx.accountAdministration` to `ctx.authority.require`. The service asserts the current call, maps `disable` to `account:disable` and the other administrator actions to matching catalog entries, and resolves an account resource to the user's unique active team. It does not store grants, does not compute Effective, and does not change account lifecycle flows.

This package is the Consumer. A deployment mounts it as `ctx.accountAuthority` after `ctx.auth`, `ctx.authority`, `ctx.accountAdministration`, `ctx.tenants`, and `ctx.teams`. Without this plugin, account administrator methods stay fail-closed with `forbidden`.

## Public API

| API | Purpose |
|---|---|
| `ctx.accountAuthority.authorize(request)` | Assert the actor, then require the mapped account action |

`create` uses the actor user id as the account resource. Every other action requires `target`. The resolver returns a team only when the user has exactly one active `(tenant, team)` pair. Zero or two or more pairs deny as an unresolved resource. The package does not add a team field to `AccountAdminAuthorizationRequest`.

## Administrator Operations

Mount role and object routes on authority, then register this plugin as the sole `AccountAdminAuthorizer`:

```text
accountAdministration.authorizers.authorize
  -> ctx.auth.assertCurrent
  -> ctx.authority.require(account:*)
  -> unique-team resolve
  -> RoleUse(T) ∩ ObjectUse(T)
```

Disposing the `accountAuthority` fiber unregisters the authorizer, the `account` resolver, and the `account:*` actions.

## Failure Semantics

Authorizer throws become account `forbidden`. `ctx.authority.require` deny categories stay inside that mapping. A missing authorizer is still account `forbidden`.

## Model Experience

### Account-administration authorization

#### What the model sees

Nothing. `ctx.accountAuthority.authorize` results, membership lookups, and Effective decisions are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. Account-administration authorization does not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Account-administration authorization does not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **Authorization policy stays outside account** - this package only wires `ctx.authority.require`. Role catalogs and object grants remain in their owners.
- **Unique team only** - a user on two teams cannot be administered until a later account request field names the team.
- **Account revision is 1** - this package does not version account rows.
- **Must be the sole authorizer** - a second `AccountAdminAuthorizer` is a conflict.
