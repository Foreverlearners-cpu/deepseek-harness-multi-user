# Agent Note: dsh-authority decision service

Status: proposed

English | [中文](2026-08-26-dsh-authority-decision-service.zh.md)

## Problem

Role qualifications and object grants are independent facts. A caller who can execute plugins in one team must not inherit execute on a resource granted only to another team. Authentication answers who the caller is. Tenant and team directories answer membership. No existing package intersects those facts at one fail-closed decision point.

Putting authorization into `dsh-auth` would make identity carry permission. Computing the intersection inside RBAC or ACL would let one route invent the merge rule. Reading MySQL from the center would bind the decision API to the first storage Provider.

The repository needs a provider-neutral authorization runtime before RBAC, ACL, or tenant-boundary Consumers. The service must own the action catalogue, resource-resolver registry, route-provider registry, default deny, and the same-team intersection. It must not store roles or grants.

## Proposal

Add `@deepseek-ai/dsh-authority` as the Service Definition and decision engine. A deployment mounts exactly one instance as `ctx.authority` after `ctx.auth`. The package injects `auth` only to call `assertCurrent`. It imports branded `UserId`, `TenantId`, and `TeamId` validators and does not call `ctx.users`, `ctx.tenants`, or `ctx.teams`.

`AuthorityRequest` is a current `AuthenticatedCall`, a catalogued action, and an untrusted `{ type, id }` pointer. Domain plugins register a `ResourceResolver` that returns type, id, tenant, team, and revision. Client-supplied tenant or team fields are ignored.

Each route Provider receives the already-resolved `(user, tenant, team T, action, resource, set)` and returns the Use or Delegate action set for that one team. This package only intersects:

```text
Effective(T) = RoleSet(user, T) ∩ ObjectSet(resource, T)
```

`T` is the team on the trusted resource. The runtime never unions sets from different teams. Use decisions request `set: 'use'` from both routes; Delegate sets never enter a Use decision. That merge rule is not a `Config` field.

`decide()` returns allow or a deny category. `require()` throws the deny category. Missing Providers, unknown actions, resolver failures, invalid Provider results, and unexpected throws are deny.

## Decision inputs

| Value | Owner |
| --- | --- |
| `AuthenticatedCall` | `dsh-auth`; this package revalidates provenance and requires a user principal. |
| `ActionCode` | Action catalogue registered by domain or policy plugins. |
| `ResourceRef` | Caller-supplied type and id only. |
| `TrustedResourceRef` | Resource resolver; includes tenant, team, and revision. |
| Role set on `T` | Later `dsh-auth-rbac` route Provider. |
| Object set on `T` | Later `dsh-authority-acl` route Provider. |

The center does not expand team membership into per-user grants and does not decide how a route builds its set.

## Alternatives considered

**Put authorization into `dsh-auth` or `AuthenticatedCall`.** Rejected because authentication answers who the caller is. Carrying roles, teams, or grants on the call would mix identity with authorization and force every authenticated request to pick a permission scope.

**Union every team the user belongs to, then intersect with the union of every object grant.** Rejected because a research-team runner would inherit execute on a resource granted only to operations. Same-team intersection is the product rule.

**Let RBAC or ACL compute the final ALLOW/DENY.** Rejected because each route would own the merge rule and could silently change it. Both routes only report the set on one team; this package intersects.

**Read MySQL, Redis, or membership tables from the center.** Rejected because the Service Definition must stay provider-neutral. Storage belongs to later route Providers. Membership remains `dsh-tenant` and `dsh-team`.

**Make the merge rule a `Config` field.** Rejected because a deployment must not be able to switch the runtime to a cross-team union. The intersection is a security invariant.

## Acceptance criteria

- The package defines `decide`/`require`, an action catalogue, route-provider and resource-resolver registries that return disposers, stable deny categories, and a fixture Provider contract suite.
- The package does not import an authentication implementation beyond `dsh-auth`, does not import authorization storage, Session, transport, database, or cache packages, and opens no external resource.
- Same-team intersection is the only merge: research-team role plus operations-team object grant is deny; same-team membership on both routes is allow.
- Only one of the two route sets containing the action is deny. Missing Provider, unknown action, resolver failure, and disposed Provider are deny.
- Use decisions do not read Delegate sets. Delegate decisions do not read Use sets.
- Focused tests cover the six required fixture cases, current-call rejection, client-claimed team ignore, malformed Provider results, and Provider disposal.
- Existing Session, Agent, authentication, tenant-directory, and team-directory behavior remains unchanged when only `dsh-authority` is added.
- RBAC, ACL, tenant-boundary, and MySQL Providers remain separate follow-up packages.

## Risks

- Using only the resolved resource team as `T` cannot yet honor a grant whose subject is a different team than the resource home team. A later ACL change must keep same-team intersection and must not introduce a cross-team union.
- Distinct deny categories help administration but may leak action or resource existence when mapped directly to a public response. Transport Consumers must collapse them where enumeration resistance requires it.
- Injecting `ctx.auth` couples load order to authentication. That is required to reject forged calls, and a missing auth service fails at plugin load.
