# @deepseek-ai/dsh-authorization

English | [中文](README.zh.md)

Default-deny action authorization Service Definition and live permission catalog. The service accepts only a privately issued [`AuthenticatedCall`](../authentication/README.md), resolves a registered product action, delegates policy evaluation to a concrete `AuthorizationProvider`, and normalizes the result into an immutable decision. It is the enforcement contract for actions such as plugin discovery, metadata disclosure, content projection, and execution.

## API

- `permissionCode(value)` validates and brands a `domain:action` code; `PermissionDefinition` adds an owner, administrative description, disclosure class, and optional resource kind.
- `AuthorizationProvider.permissions` exposes `register()`, `get()`, and `list()` for domain-owned definitions. Registration is tied to the current Cordis fiber and returns a disposer.
- `decide({ call, permission, resource, environment })` returns an immutable allow or deny decision; `require()` returns the allow decision or throws `AuthorizationDeniedError`.
- `policyVersion` and `isCurrent()` expose opaque policy freshness, while Provider implementations can invalidate an in-flight or previously observed policy through their protected policy lifecycle.
- `openLease(request, decision)` turns one current allow into an `AuthorizationLease` for a long-running operation. Its `signal` is revoked when the call is cancelled, the credential expires, the policy or permission catalog changes, or the Provider is disposed; consumers must call `release()` when the operation ends.
- `authorization/decision` and `authorization/invalidated` events carry safe audit metadata and version changes without resource contents or role-policy internals.

## Authorization contract

Authentication and authorization are deliberately separate. The call proves the Host established a principal and scope; the authorization Provider decides whether that principal may perform one registered action. Domain packages own their permission definitions, and the Provider owns the policy that evaluates them. A permission code is not a role, a UI flag, or a credential.

The base service rejects structurally forged calls and expired credentials before consulting the Provider. It rejects unknown permissions by default, contains Provider failures as denials, freezes bounded obligations, and rejects a result when the policy or permission definition changes while evaluation is in flight. A successful decision carries the policy version used so callers can require freshness at their own boundary.

`assertCurrent(request, decision)` is the consumption boundary for asynchronous handlers. Callers should invoke it immediately before lookup, source creation, and business execution when an allow may have crossed an `await`; it rejects an expired call, a disposed or foreign issuer, an unregistered/replaced permission, or an invalidated policy version. Connection applies this pattern to unary fallback routes, `/api/respond`, and session export, and performs the same final check before opening a lease for SSE and WebSocket event streams.

An `AuthorizationLease` extends that check across an operation lifetime without treating the allow decision as a durable capability. `openLease()` fails if the decision is already stale, then tracks call cancellation, credential expiry, policy/catalog invalidation, and Provider disposal through one `AbortSignal`. `release()` detaches that tracking without aborting a completed operation. Revocation is cooperative for in-process work: the Provider can abort the signal, but it cannot preempt synchronous JavaScript or an asynchronous implementation that ignores the signal. Long-running consumers must thread the signal through their work, stop producing effects or results after abort, and release the lease in cleanup.

The route permission is intentionally coarse. It answers whether the caller may enter an operation; it does not select rows or redact fields. Domain handlers remain responsible for resource-level checks and projections after the route gate, even when the route gate succeeds.

## Failure semantics

- Invalid permission codes or definitions throw `TypeError`; duplicate active owners are rejected without replacing the existing definition.
- Missing issuer evidence or an expired authenticated call produces `UNAUTHENTICATED`; the Provider is not consulted.
- An unregistered permission, Provider denial, Provider failure, unsupported principal, or stale policy produces `FORBIDDEN` and a typed internal denial reason.
- `AuthorizationDeniedError` exposes the permission, safe reason, policy version, optional request id, and carrier-safe public error without exposing resource or role details.

## Composition

This package is an abstract Service Definition. A concrete Provider must be mounted explicitly and domain packages must register their permissions in their own composition fibers. Gateway and domain methods should both enforce the relevant permission; hiding a menu or omitting a projection is not a security boundary. The `./invariant` entry checks the package-owned invalidation relation when composed with the repository invariant service.

## Model Experience

None, as permission codes, principals, resources, environment fields, and decisions remain in Host authorization paths and register no model context.

#### KV Cache effect

None; authorization decisions do not assemble or invalidate a model request prefix.

## Known Limitations and Deferred Work

- **No policy database or role engine** — the abstract Provider does not implement OIDC claims, role membership, tenant grants, operator grants, or a remote policy backend.
- **In-memory catalog per context** — permission definitions and the policy version live in the active Host context and are removed with their owning fiber.
- **No automatic resource filtering** — domains must define resource kinds, obligations, projections, and post-decision filtering for content-level disclosure.
- **Route gates do not replace resource policy** — a stable `api:*` or Remote permission allows entry to an operation, not unrestricted access to every resource returned by it.
- **No carrier adapter** — mapping `UNAUTHENTICATED` and `FORBIDDEN` to HTTP or RPC responses belongs to the Gateway or transport boundary.
- **Lease revocation is cooperative** — `AuthorizationLease.signal` cannot forcibly stop synchronous code or an API that ignores `AbortSignal`; every long-running owner must consume the signal and define how an aborted result is discarded.
