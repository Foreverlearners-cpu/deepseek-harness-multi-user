# @deepseek-ai/dsh-authentication

English | [中文](README.zh.md)

Verified immutable Host call identity Service Definition. Transport adapters submit carrier-owned evidence, the active `AuthenticationProvider` verifies it, and the service mints an `AuthenticatedCall` that downstream authorization can trust. Identity is passed explicitly through Host code and is never taken from an RPC JSON payload.

## API

- `AuthenticationProvider` exposes `authenticate(attempt)` and leaves carrier verification to its protected `verify(attempt)` implementation. Only this service mints accepted calls.
- The branding helpers `authenticationRequestId()`, `userId()`, `serviceAccountId()`, `localPrincipalId()`, `tenantId()`, `membershipId()`, `operatorGrantId()`, and `authenticationMethod()` validate stable identifiers before they enter the call context.
- `AuthenticatedCall`, `AuthenticationAttempt`, `VerifiedAuthentication`, principal types, scopes, and carrier evidence types are exported from the package and its `./types` entry.
- `isAuthenticatedCall()` performs the runtime issuer check, while `AuthenticationError` carries the safe `unauthenticated` or `authentication-unavailable` category for a carrier response.

## Authentication contract

An attempt contains a Host-generated request id, a channel, carrier-owned evidence, and the request cancellation signal. The current evidence map includes retained HTTP `Request` values and an explicit same-process `in-process` carrier. Providers return a principal, authentication method, tenant or platform scope, and optionally an expiry timestamp. The service copies and freezes provider-owned identity data, binds the call to the attempt metadata, and records the exact object in a private issuer set.

The issuer set is authoritative at runtime. A structural copy, JSON round trip, client payload, or object with the same fields is not an authenticated call. This keeps authentication evidence on the Host side while allowing authorization and domain code to receive an explicit immutable value.

## Failure semantics

- Invalid branded identifiers throw `TypeError` before a Provider can mint a call.
- A Provider verification error is propagated and no call is issued.
- A non-finite `expiresAt` returned by a Provider becomes `AuthenticationError` with `authentication-unavailable`.
- Expiration is preserved on the call; authorization is responsible for rejecting an expired call before evaluating a permission.

## Composition

This package is a Service Definition, not a login screen or a credential database. A concrete Provider must be mounted explicitly in the Host context. Transport adapters call `authenticate()` while they still own the original carrier request, then pass only the resulting call into protected application code. The invariant companion is exported from `./invariant` and checks the package-owned runtime relation when composed with the repository invariant service.

For the Connection Host adapter this includes the legacy API face: the original `Request` is authenticated before a unary or `/api/respond` body is parsed, before a session export or SSE source is opened, and during event-stream WebSocket upgrade. The resulting call remains out of band; route permissions and domain resource checks consume it separately.

## Model Experience

None, as principal ids, membership ids, scopes, and carrier evidence remain Host-side authorization inputs and never enter a model request.

#### KV Cache effect

None; authentication metadata is not assembled into the model request prefix.

## Known Limitations and Deferred Work

- **Provider-specific verification** — this package does not parse OIDC tokens, sessions, API keys, or remote identity stores; those belong in a concrete Provider and transport adapter.
- **No built-in revocation store** — the optional expiry is copied into a call, while revocation and policy changes are owned by the Authentication or Authorization Provider.
- **Explicit composition required** — the base service has no anonymous fallback and should not be mounted without a deliberate authentication policy.
- **Carrier map is intentionally narrow** — adding a new transport requires a typed `AuthenticationEvidenceMap` extension and a Host adapter that keeps the evidence outside business payloads.
- **Authentication is only the first gate** — a valid call does not authorize an action or filter returned resources. The route adapter and domain method must still enforce a permission and resource-level policy.
