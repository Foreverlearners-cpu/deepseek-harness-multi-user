# Agent Note: dsh-auth Provider and Consumer composition

Status: proposed

English | [中文](2026-08-23-dsh-auth-provider-and-consumer-composition.zh.md)

## Problem

The proposed [`dsh-auth` service](2026-08-23-dsh-auth-identity-and-credential-lifecycle.md) separates authentication rules from JWT, API-key, transport, tenant, and authorization plugins. That split is useful only if Provider authors and transport Consumers can compose the service without reconstructing identity objects, parsing each other's credential formats, depending on plugin load order, or adding an implicit anonymous fallback.

Implementers need one proposed integration path that shows how an authenticator registers, how a transport submits evidence, how a Host Consumer checks an authenticated call, and where token issuance, tenant derivation, and authorization begin and end.

## Proposal

Use `ctx.auth` as the only same-process entry to authentication. A concrete Provider plugin registers typed evidence verification and optional credential-lifecycle capabilities through Cordis effects. A transport Consumer extracts exactly one credential from Host-owned carrier data, calls `authenticate()`, and passes the resulting call through Host-only invocation context. A protected Consumer calls `assertCurrent()` immediately before it consumes the identity or passes it to tenant and authorization services.

### Inject an authentication Provider

A Provider package depends on `@deepseek-ai/dsh-auth`, validates its own configuration at plugin activation, constructs one Provider descriptor, and registers it for one evidence kind. The following proposed API is illustrative rather than shipped source:

```ts ignore-check
import type { Context } from '@deepseek-ai/cordis'
import type { AuthenticationProvider } from '@deepseek-ai/dsh-auth'

const provider: AuthenticationProvider<'bearer'> = {
  async verify(attempt) {
    const claims = await verifier.verify(attempt.evidence.token, {
      audience: attempt.audience,
      signal: attempt.signal,
    })
    return {
      principal: { kind: 'user', id: userId(claims.subject) },
      method: authenticationMethod('jwt'),
      credentialId: credentialId(claims.tokenId),
      authenticatedAt: clock.now(),
      expiresAt: claims.expiresAt,
    }
  },
}

export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.auth.providers.register('bearer', provider),
    'dsh-auth-jwt: bearer authentication Provider',
  )
}
```

The Provider returns verified facts and never constructs `AuthenticatedCall`. It does not register roles, select a tenant, or return raw claims. The core service copies those facts, mints the call, and records the Provider registration that issued it. The disposer removes that registration; a second active registration for `bearer` fails rather than replacing it.

An API-key Provider follows the same pattern under `api-key`. It compares a one-way verifier, returns a user or service-account principal, and may register inspect and revoke lifecycle capabilities. It does not implement refresh merely to match JWT.

### Select one Provider

The transport maps carrier syntax to one evidence kind before calling `dsh-auth`:

```text
Authorization: Bearer <value>  -> bearer
X-API-Key: <value>             -> api-key
trusted same-process entry     -> in-process
```

Exactly one recognized credential is allowed per request. No credential produces `unauthenticated`; several credentials produce an ambiguous-credential refusal; one credential selects the sole Provider registered for its evidence kind. Verification failure ends the request and never falls through to another Provider.

Several JWT issuers do not create several top-level `bearer` Providers. `dsh-auth-jwt` owns an issuer registry and uses untrusted token metadata only to select one configured verifier. That verifier must validate the signature, exact issuer, intended audience, time claims, token kind, and credential state. Unknown issuer, ambiguous configuration, or validation failure rejects without trying another issuer.

### Authenticate a transport request

`dsh-auth-gateway` owns HTTP, WebSocket, SDK, ACP, and in-process evidence extraction. For an HTTP request, it applies the existing Host and Origin checks first, rejects multiple credential sources, then calls:

```ts ignore-check
const call = await ctx.auth.authenticate({
  requestId: authenticationRequestId(randomUUID()),
  channel: 'http',
  evidence: { kind: 'bearer', token },
  audience: configuredAudience,
  signal: requestSignal,
})
```

The call remains outside the parsed business payload. Connection and Gateway pass it through a Host-only request context. HTTP maps missing, invalid, expired, or revoked credentials to a generic `401`; Provider unavailability maps to a bounded service failure. WebSocket authentication occurs before upgrade. Neither carrier returns raw credential values, account-existence details, Provider diagnostics, or unverified claims.

### Consume an authenticated call

A Host Consumer that relies on identity checks freshness immediately before use:

```ts ignore-check
const call = ctx.auth.assertCurrent(requestContext.call)
```

The returned call proves the current process authenticated one principal for this request. It does not prove that the principal may perform an operation or access a tenant. A Consumer that needs tenant data passes the call to `dsh-tenant-scope`; a Consumer that protects a product action passes the current call and any required scope or resource identity to `dsh-authority`.

Business plugins do not parse Authorization headers, cookies, JWT claims, or API keys. They also do not read a global `currentUser`. Plugins that do not depend on caller identity remain unchanged. Resource owners receive an explicit security context only when their operation requires identity, tenant, or authorization decisions.

### Use credential lifecycle operations

Login, refresh, device-management, and logout Consumers use `ctx.auth.credentials`; ordinary business requests do not. A JWT login Consumer asks the configured JWT capability to issue an access and refresh pair after its upstream login or OIDC exchange succeeds. Refresh submits the refresh secret to the same Provider, which atomically rotates it. Logout revokes the individual credential or token family according to the requested scope.

```ts ignore-check
const pair = await ctx.auth.credentials.issue('jwt', issueRequest)
const rotated = await ctx.auth.credentials.refresh('jwt', refreshRequest)
await ctx.auth.credentials.revoke('jwt', revokeRequest)
```

The exact operation accepts only a Provider that registered the named capability. An API-key Provider can expose `inspect` and `revoke` while rejecting `refresh` as unsupported. Credential results are secret-bearing values and must be written only to their intended response or secure store.

### Composition and failure rules

A production composition that mounts `dsh-auth-gateway` must mount every Provider required by its accepted credential methods. Missing required registration fails during composition when resolvable. Server profiles have no anonymous or local fallback. A local profile may explicitly mount a separate loopback-only Provider, but a network-capable composition rejects that Provider.

P0 `dsh-auth` alone changes no existing transport or business behavior. Adding a Provider alone makes no route authenticated. The first runtime behavior change occurs when `dsh-auth-gateway` consumes the service, and protected product behavior additionally requires `dsh-authority` and the relevant resource-owner checks.

### Provider and Consumer tests

Provider tests use the real registration API and verify valid, invalid, expired, revoked, wrong-audience, and unavailable outcomes without logging credentials. Consumer tests prove Host/Origin checks precede credential use, ambiguous credentials fail, authentication precedes business-payload dispatch, the call never appears in wire arguments, and a rejected request never invokes its business handler. Cross-package assembled tests belong to the Gateway change that first activates authentication.

## Alternatives considered

**Let Gateway call JWT and API-key plugins directly.** Rejected because every transport would duplicate Provider selection, normalized identity, expiry, provenance, error, and event behavior.

**Inject the Provider by replacing `ctx.auth`.** Rejected because JWT and API-key authentication must coexist, while one Provider must not own the service's provenance and lifecycle rules.

**Register several Providers for one evidence kind and try them in order.** Rejected because plugin order would become security policy, failure timing would vary, and a strict Provider failure could reach a more permissive Provider.

**Pass raw credentials to business plugins.** Rejected because it spreads secret handling and token-format dependencies beyond authentication owners.

**Put the authenticated call in RPC JSON.** Rejected because the client could construct or replay identity fields and the process-private provenance proof would be lost.

## Acceptance criteria

- A Provider author can register one evidence verifier through an effect and can add only the lifecycle capabilities that its credential kind implements.
- A transport Consumer extracts exactly one credential, chooses one evidence kind, authenticates before business dispatch, and passes the resulting call outside wire DTOs.
- Duplicate Provider ownership, absent required Providers, ambiguous request credentials, unknown issuers, and verification failures reject without fallback.
- A Host Consumer uses `assertCurrent()` before relying on identity and delegates tenant and product-permission decisions to their owning services.
- JWT issuer selection never treats unverified `iss` or `kid` as authenticated facts and never retries another issuer after verification failure.
- Provider and Consumer examples contain no role, tenant, business permission, raw-claim propagation, or global current-user mechanism.
- The integration guide remains proposed until executable package APIs and assembled tests establish the documented names and behavior.

## Risks

- Illustrative API names can drift while the core package is implemented. The note must move to implemented only after its examples match exported types and real composition.
- Strict rejection of several credentials can expose clients that currently send redundant headers. Gateway release notes and client tests must make the one-credential rule explicit.
- One top-level Provider per evidence kind moves multi-issuer complexity into L2 packages. Those packages need deterministic issuer and key selection, bounded remote-key refresh, and explicit configuration conflicts.
- Authentication before body dispatch cannot prevent every transport-level resource cost if a bridge buffers the body first. Gateway design must place credential checks before buffering where the carrier permits it and document remaining limits.
