# @deepseek-ai/dsh-auth

English | [中文](README.zh.md)

Host authentication contract and runtime. The package selects exactly one authentication Provider from the
submitted evidence kind, asks that Provider to verify the credential, and mints an immutable `AuthenticatedCall`
whose origin can later be checked. It also routes optional credential issue, refresh, inspect, and revoke operations
to the Provider that owns an authentication method.

This is the P0 authentication foundation. It does not parse JWTs or API keys, grant permissions, derive tenant
scope, or install itself in an application bundle. Those responsibilities belong to later Provider, authorization,
tenant, gateway, and starter packages.

## Public API

| API | Purpose |
|---|---|
| `ctx.auth.authenticate(attempt)` | Select the Provider for `attempt.evidence.kind`, verify the evidence, and mint an `AuthenticatedCall` |
| `ctx.auth.assertCurrent(value)` | Prove that the exact object came from this live runtime and that its Provider, request, and expiry remain current |
| `ctx.auth.providers.register(kind, provider)` | Register the sole Provider for one evidence kind and authentication method; returns an idempotent disposer |
| `ctx.auth.credentials.issue(method, request)` | Ask the method's Provider to issue credentials |
| `ctx.auth.credentials.refresh(method, request)` | Ask the method's Provider to rotate a refresh credential |
| `ctx.auth.credentials.inspect(method, request)` | Read safe credential metadata without returning secrets |
| `ctx.auth.credentials.revoke(method, request)` | Revoke a credential, token family, or principal's credentials |

The first two methods answer different questions. `authenticate()` establishes identity from untrusted carrier
evidence. `assertCurrent()` does not authenticate a token again; it checks that an in-process value is the exact
`AuthenticatedCall` previously minted by this runtime. A copied object or JSON round trip is rejected.

## Provider selection

Selection is deterministic: `attempt.evidence.kind` is the registry key. `bearer` selects the one registered bearer
Provider, while `api-key` selects the one registered API-key Provider. The runtime never tries Providers in sequence
and never accepts the first one that happens to succeed. Registering two Providers for the same evidence kind, or two
Providers claiming the same authentication method, fails immediately with `provider-conflict`.

One bearer Provider may internally support several JWT issuers. Issuer selection is part of JWT verification inside
that Provider, not a second global Provider-selection mechanism. A future gateway is responsible for rejecting a
request that presents several credential carriers at once.

## Implementing and injecting a Provider

An authentication implementation first extends the evidence map with the exact carrier shape it owns:

```ts
declare module '@deepseek-ai/dsh-auth/types' {
  interface AuthenticationEvidenceMap {
    bearer: { readonly kind: 'bearer'; readonly token: string }
  }
}
```

It then registers one Provider as a plugin-owned effect. Keeping the returned disposer in `ctx.effect()` ensures
that HMR, plugin failure, and normal shutdown remove the route and invalidate calls minted through that registration.

```ts
import type { Context } from '@deepseek-ai/cordis'
import { authenticationMethod, credentialId, userId } from '@deepseek-ai/dsh-auth'

export const inject = ['auth']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.auth.providers.register('bearer', {
    method: authenticationMethod('jwt'),
    async verify(attempt) {
      const claims = await verifyJwt(attempt.evidence.token, attempt.signal)
      return {
        principal: { kind: 'user', id: userId(claims.subject) },
        credentialId: credentialId(claims.jwtId),
        authenticatedAt: Date.now(),
        expiresAt: claims.expiresAt,
      }
    },
  }))
}
```

`verifyJwt()` above is deliberately Provider-specific pseudocode. Raw credentials stay inside the Provider. Errors
safe for callers may be thrown as `AuthenticationError`; unexpected errors are normalized to
`authentication-unavailable` so internal details do not become transport responses.

Credential lifecycle functions are optional members of `provider.credentials`. A Provider should implement only
operations whose storage and revocation semantics it genuinely owns. Calling an absent operation fails with
`credential-operation-unsupported`.

## Using authentication

Only a trusted transport adapter should construct an `AuthenticationAttempt`. It extracts exactly one credential
carrier, assigns a Host request id and cancellation signal, then authenticates before passing the resulting call to
downstream code:

```ts
const call = await ctx.auth.authenticate({
  requestId: authenticationRequestId(request.id),
  channel: 'http',
  evidence: { kind: 'bearer', token: request.bearerToken },
  signal: request.signal,
})

handleRequest(ctx.auth.assertCurrent(call))
```

The data flow is therefore: transport evidence -> exact Provider -> verified identity facts -> runtime-minted
`AuthenticatedCall` -> authorization or tenant consumers. Tokens remain Provider input; `AuthenticatedCall` is the
trusted in-process identity passed downstream.

The runtime emits `auth/result` with request, method, principal, outcome, and safe failure category. The event never
contains the raw token or issued credential value. The optional invariant companion at
`@deepseek-ai/dsh-auth/invariant` checks that these events are emitted only while the authentication service is live.

## Failure semantics

| Code | Meaning |
|---|---|
| `unauthenticated` | Evidence is rejected, expired, cancelled, or the call is no longer usable |
| `authentication-unavailable` | No matching Provider exists, the Provider changed mid-verification, or it failed internally |
| `provider-conflict` | A second Provider claimed an existing evidence kind or method |
| `credential-operation-unsupported` | The selected method does not implement the requested lifecycle operation |

## Model Experience

### Authentication state

#### What the model sees

Nothing. Authentication evidence, `AuthenticatedCall` identity facts, and `auth/result` audit events are Host-only; this package registers no prompt section, tool, or session event that could expose them to the model.

#### Token effect

Zero. Authentication does not add, remove, or rewrite any model-input tokens.

#### KV Cache effect

Independent. Authentication changes no model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **No concrete credential format** - JWT and API-key parsing, signing, storage, rotation, and revocation belong to
  dedicated Provider packages.
- **No transport integration** - gateway code must extract one carrier, reject ambiguous credentials, map errors to
  protocol responses, and keep `AuthenticatedCall` inside the Host process.
- **No authorization or tenancy** - permissions and `TenantScope` consume authenticated identity but remain separate
  contracts.
- **Process-local provenance** - `AuthenticatedCall` intentionally cannot survive serialization or process restart;
  another process must authenticate its own carrier evidence.
- **No bundle activation** - adding this package to the build graph does not enable authentication in a product.
