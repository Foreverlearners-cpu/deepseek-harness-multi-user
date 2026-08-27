# Agent Note: dsh-tenant-authority cross-tenant guard

Status: proposed

English | [中文](2026-08-27-dsh-tenant-authority-cross-tenant-guard.zh.md)

## Problem

Authorization must refuse a caller who presents another tenant's valid resource id without telling them the resource exists. Role and object routes report action sets after a resource is resolved. If those routes deny with `insufficient-permission`, a caller can distinguish a live foreign id from a missing one.

Putting the tenant-equality rule into ACL rows would let a grant author forget it. Putting a tenant onto `AuthenticatedCall` would mix identity with selected scope. Changing `dsh-authority` to add a third route or a new deny code would move a product isolation rule into the intersection engine.

The repository needs a decide entry that compares trusted actor scope to the resolved resource tenant, hides existence on mismatch, and leaves Effective in `dsh-authority`.

## Proposal

Add `@deepseek-ai/dsh-tenant-authority` as the cross-tenant guard. A deployment mounts exactly one instance as `ctx.tenantAuthority` after `ctx.auth`, `ctx.authority`, and `ctx.tenants`. Product callers use `decide` / `require` on this service. The package injects those three services. It does not compute Effective and does not read role or grant rows.

The request carries a trusted `scope`. Tenant scope names the selected tenant. The runtime requires an active membership in that tenant, resolves the resource, and continues to `ctx.authority.decide` only when the resource tenant equals the selected tenant. A valid id from another tenant, a missing id, a non-member, and platform scope all return `unresolved-resource`.

Platform scope is not tenant membership. This package never treats an operator grant as access to a tenant resource.

`dsh-authority` has no third route. This package registers domain resolvers on authority so one registration serves both the guard and the intersection engine. Compositions that call `ctx.authority.decide` directly do not get the not-found rule; the README states that this plugin must be mounted.

## Decision inputs

| Value | Owner |
| --- | --- |
| Trusted actor scope | Transport / control plane, not the resource pointer. |
| Active membership | `ctx.tenants.requireActiveMembership`. |
| Resource tenant | Domain resolver registered through this service. |
| Effective | `dsh-authority` after the tenant check passes. |

The public deny for a foreign valid id matches the public deny for a missing id. The [identity and access](../../../docs/multi-user/identity-and-access.md) not-found rule is the product requirement.

## Alternatives considered

**Return `insufficient-permission` for a foreign valid id.** Rejected because that code proves the resolver found a resource. The public category must match not-found.

**Encode tenant equality as an ACL grant.** Rejected because a missing grant row would leak the isolation rule into every resource author. The check belongs in one Consumer.

**Put `tenantId` on `AuthenticatedCall`.** Rejected because authentication answers who the caller is. Selected tenant is authorization scope.

**Add a third authority route or a new deny code to `dsh-authority`.** Rejected because the intersection engine must not own tenant isolation. This package is the decide entry; authority stays fail-closed for missing role or object Providers.

**Treat platform scope as a tenant wildcard.** Rejected because platform operators do not automatically receive tenant transcript or resource access.

## Acceptance criteria

- The package defines `registerResolver`, `match`, `decide`, `require`, branded scope, and a fixture contract suite.
- The package does not import authorization storage, Session, transport, database, or cache packages, and opens no external resource.
- Same-tenant membership plus intersecting routes returns allow.
- A valid resource id from another tenant returns `unresolved-resource`, the same code as a missing id.
- Platform scope returns `unresolved-resource` and does not call membership as a grant.
- Existing Session, Agent, authentication, tenant-directory, team-directory, authority, RBAC, and ACL behavior remains unchanged when only `dsh-tenant-authority` is added.

## Risks

- Callers that still invoke `ctx.authority.decide` bypass the not-found rule. Later starter composition must mount this plugin and hide the raw decide entry from product methods.
- Membership-directory outages fail the whole evaluation. Transport Consumers must not map that category to a public signal that enumerates tenants.
- Resolving before `authority.decide` performs a second resolve inside authority. The double lookup is accepted so this package can hide existence without changing the authority kernel.
