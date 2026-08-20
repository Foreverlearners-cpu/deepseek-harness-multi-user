# @deepseek-ai/dsh-authorization-static

English | [中文](README.zh.md)

Explicit in-memory authorization Provider for bootstrap and local profiles. `StaticAuthorizationProvider` implements the shared [`authorization`](../authorization/README.md) contract with exactly two composition modes: `deny-all`, which refuses every registered action, and `trusted-local`, which allows registered actions only for an authenticated `local` principal.

## API

- `Config` requires an explicit `mode` of `deny-all` or `trusted-local`; there is no permissive default.
- `StaticAuthorizationProvider` is the default export and extends `AuthorizationProvider`, including the shared permission catalog, call authenticity checks, policy versions, and denial events.
- In `deny-all`, every registered permission is denied with `provider-denied`; in `trusted-local`, non-local principals are denied with `principal-unsupported`.
- The `./invariant` entry provides the package companion registration for contexts that compose the repository invariant service.

## Authorization contract

The mode is a deliberately small policy for a local bootstrap boundary. It does not replace authentication: callers still need a privately issued `AuthenticatedCall`, and domains still need to register the permission they are protecting. The shared base service continues to reject forged calls, expired calls, unknown permissions, Provider failures, and stale policy decisions.

`trusted-local` matches the principal kind, not a hostname, loopback address, anonymous id, or client-provided label. It therefore remains explicit and testable, while the composition that mounts it decides whether the local principal is an acceptable trust root.

## Failure semantics

- Unsupported or missing modes fail configuration validation and Provider activation with `TypeError`.
- `deny-all` returns `FORBIDDEN` for every registered action, including actions requested by a local principal.
- `trusted-local` allows only a valid, non-expired call whose principal kind is `local`; other principal kinds return `principal-unsupported` and `FORBIDDEN`.
- Shared authorization failures retain their normal `UNAUTHENTICATED` or `FORBIDDEN` categories and typed denial reasons.

## Composition

Mount this Provider only when an explicit bootstrap policy is enough, such as a local desktop profile, isolated test, or a deliberate deny-all deployment. It is normally composed with [`authentication-local`](../authentication-local/README.md) for a trusted local profile, but the two services remain independent. The package does not expose a role editor, grant store, or runtime policy administration surface.

## Model Experience

None, as the static Provider only evaluates Host authorization requests and registers no model context.

#### KV Cache effect

None; changing the static mode does not assemble a model request prefix.

## Known Limitations and Deferred Work

- **No dynamic grants** — the Provider cannot express users, service accounts, tenant memberships, operator grants, or resource-level conditions.
- **No remote deployment policy** — `trusted-local` is not a substitute for OIDC, API-key, session, or service-to-service authentication.
- **Composition-time mode** — changing the mode requires replacing or reloading the Provider; existing decisions are not an administrative policy store.
- **Registered actions still required** — the Provider does not invent permission definitions, and unknown actions remain denied by the shared base service.
