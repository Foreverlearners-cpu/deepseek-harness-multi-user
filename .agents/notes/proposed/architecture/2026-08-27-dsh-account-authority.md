# Agent Note: Account-administration authority wiring

Status: proposed

English | [中文](2026-08-27-dsh-account-authority.zh.md)

## Problem

`dsh-account` requires one `AccountAdminAuthorizer` and fails closed when that Provider is missing or throws. Authorization policy must stay outside account lifecycle. A later composition needs that authorizer to call `ctx.authority.require` so same-team Effective decides administrator actions, without adding a team field to `AccountAdminAuthorizationRequest` when membership already names exactly one team.

## Proposal

Add `@deepseek-ai/dsh-account-authority` as the Consumer that registers the unique authorizer on `ctx.accountAdministration`. `authorize` calls `ctx.auth.assertCurrent`, maps `create` / `update` / `disable` / `enable` / `reset-password` / `revoke-sessions` to `account:*`, and requires that action on resource type `account`. `create` uses the actor user id. Other actions use `target`.

The package also catalogues those actions and registers the `account` resolver. The resolver lists active tenant and team memberships and returns a trusted resource only when exactly one `(tenant, team)` pair exists. Zero or two or more pairs are unresolved. The trusted revision is 1 because this package does not version account rows.

The package does not compute Effective, store grants, read MySQL, or change `dsh-account` flows. Cross-team mix remains deny because Effective still intersects RoleUse and ObjectUse on the resolved resource team only.

## Alternatives considered

**Put the authorizer inside `dsh-account`.** Rejected because account orchestration must stay policy-free. A missing or throwing authorizer already fails closed there.

**Add `teamId` to `AccountAdminAuthorizationRequest` now.** Rejected while membership can yield exactly one team. A later change may add that field when an administrator must name which team is managing.

**Union the actor's teams, then intersect.** Rejected because cross-team mix is deny. The resolver supplies the target's unique team; Effective runs on that team only.

**Call `decide` from a grant writer.** Rejected because this package does not write grants.

## Acceptance criteria

- The plugin is the sole `AccountAdminAuthorizer` and calls `assertCurrent` then `ctx.authority.require`.
- Administrator actions without this plugin remain account `forbidden`.
- Same-team RoleUse ∩ ObjectUse allows the mapped action.
- A target whose unique team is not the actor grant team is `forbidden`.
- A user on two teams is unresolved and does not add an account request field.
- A test-only `cordis.yml` boots through the vendored Loader.

## Risks

- A user who joins a second team becomes un-administrable until a later request field names the team.
- Account resource revision stays 1, so object grants that key on revision do not follow membership churn.

## Verification

Focused tests cover missing wiring, same-team allow, cross-team deny, multi-team unresolved, create-uses-actor, membership lookup failure, and fiber disposal. A Loader-booted `cordis.yml` covers REAL composition.
