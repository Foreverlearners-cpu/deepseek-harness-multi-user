# Agent Note: dsh-auth identity and credential lifecycle

Status: proposed

English | [中文](2026-08-23-dsh-auth-identity-and-credential-lifecycle.zh.md)

## Problem

The Harness has Host and Origin checks, anonymous installation identity, sandbox policy, and user approval, but none of these establish the principal that initiated a request. A browser payload can carry a user-like field, yet no Host service can distinguish that assertion from an identity verified through a credential. Authentication adapters added independently to HTTP, WebSocket, SDK, ACP, or in-process entry points would also produce incompatible identities, failures, expiry handling, and secret-redaction rules.

The proposed multi-user architecture requires authentication before tenant derivation and authorization, but its broad plan does not assign the authentication package's exact responsibilities. A foundation package that also parses JWT, selects tenant membership, evaluates roles, or modifies every Remote method would couple independently evolving mechanisms and reproduce the large change surface of a combined authentication and authorization implementation.

The system needs one package that defines authenticated principal identity, authenticates carrier-owned evidence through replaceable providers, mints request-scoped calls that client data cannot forge, and defines credential lifecycle semantics without owning a concrete token format or product permission model.

## Proposal

Add `@deepseek-ai/dsh-auth` under `packages/identity/auth` as the L1 authentication Service Definition and orchestrator. The package provides `ctx.auth`, an effect-owned authentication-provider registry, normalized principal and credential identifiers, immutable authenticated calls, credential lifecycle interfaces, safe authentication events, and stable failure categories. It does not mount itself in a shipped bundle until a concrete Provider and a transport Consumer are composed.

The complete authentication capability remains split across roles. `dsh-auth` owns shared rules and orchestration; packages such as `dsh-auth-jwt` and `dsh-auth-apikey` implement verification and credential lifecycle behavior; `dsh-auth-gateway` extracts carrier evidence and consumes authenticated calls at transport entry points. This note refines the authentication portion of the [multi-user control and data planes proposal](2026-08-18-multi-user-control-and-data-planes.md): `AuthenticatedCall` establishes a principal, while `dsh-tenant-scope` separately derives tenant membership and platform scope.

### Minimal service API

The request path has two Consumer operations and one Provider-extension operation. `ctx.auth.authenticate(attempt)` verifies untrusted evidence through the selected Provider and mints an `AuthenticatedCall`. `ctx.auth.assertCurrent(call)` returns the same call only when exact-object provenance, Provider registration, cancellation, and expiry remain valid; otherwise it throws a stable authentication failure. `ctx.auth.providers.register(evidenceKind, provider)` installs the sole active Provider for one evidence kind and returns its disposer. A boolean `isCurrent()` is deferred until a real Consumer needs non-throwing inspection because it would duplicate `assertCurrent()` behavior.

Credential issuance is distinct from call authentication. JWT or API-key Providers create raw credentials; `authenticate()` consumes those credentials and creates a Host-only call. Optional lifecycle operations are grouped under `ctx.auth.credentials` for login, refresh, device inspection, and logout Consumers, not ordinary business requests. Their Provider capabilities include `issue`, `refresh`, `inspect`, and `revoke`; a credential kind exposes only the capabilities it actually implements.

### Principal identity

`dsh-auth` defines branded identifiers for users, service accounts, local principals, credentials, token families, authentication requests, and authentication methods. An authenticated principal is a closed union of `user`, `service-account`, and `local`. Roles, permissions, tenant membership, operator grants, data scope, quota, and object visibility are absent from the principal because those facts have independent owners and lifecycles.

A verified authentication result contains the principal, authentication method, optional credential id, authentication time, and optional credential expiry. Provider-specific claims remain private to the Provider unless a later package defines a normalized extension with a named consumer. The core result has no arbitrary claims bag because such a bag would become an implicit authorization and tenant API.

### Carrier evidence and Provider selection

Transport Consumers create an authentication attempt from Host-owned facts before business payload dispatch. An attempt contains a Host-generated request id, carrier channel, typed evidence, cancellation signal, and the intended audience when the credential format requires one. Raw bearer tokens, API keys, cookies, or in-process attestations are evidence, not identity.

An extensible `AuthenticationEvidenceMap` assigns each evidence kind to its typed fields. Providers register for exactly one evidence kind through `ctx.auth.providers.register()`. Registration is a Cordis effect, duplicate active ownership fails, and disposal removes the Provider and invalidates request-scoped calls that it issued. Authentication selects the Provider by exact evidence kind; it never probes Providers in sequence and never falls back to anonymous or local identity after a failure.

The transport Consumer rejects a request that presents several recognized credentials, such as a bearer token and an API key together, instead of applying a hidden precedence rule. Several trust sources that share one carrier syntax remain inside one L2 Provider. For example, the sole `bearer` Provider may maintain a configured JWT-issuer registry: an unverified `iss` or `kid` may select one candidate verifier, but acceptance still requires that verifier to validate signature, issuer, audience, time claims, and credential status. Failure never tries another issuer. The sole `api-key` Provider may similarly use a non-secret key prefix to select one backing store before comparing the stored verifier.

Missing evidence, malformed evidence, and rejected credentials produce `unauthenticated`. A configured Provider that cannot complete verification produces `authentication-unavailable`. A missing Provider is a load or deployment error when composition can resolve it and otherwise fails the request closed. Public errors do not distinguish unknown accounts from invalid credentials and do not include Provider diagnostics.

### Authenticated calls

Only `dsh-auth` mints `AuthenticatedCall` after a Provider returns verified facts. The call binds the principal to the Host request id, carrier channel, cancellation signal, authentication time, authentication method, optional credential id, optional expiry, and the exact Provider registration that verified it. The service copies and freezes Provider-owned objects before recording the exact call object in process-private provenance maps.

Structural copies, JSON round trips, client payloads, objects minted by another `ctx.auth` instance, calls from a disposed Provider registration, and expired calls fail the current-call check. `assertCurrent()` is the common consumer operation. It validates provenance, Provider registration, cancellation, and expiry immediately before an authenticated operation consumes the call. Authentication establishes identity only; a current call does not grant any product permission or select any tenant data.

Authenticated calls stay outside wire DTOs. A transport Consumer passes the call through Host-only invocation context. No client-generated field named `userId`, `principal`, `tenantId`, or `call` can replace it. The package does not provide a process-global `currentUser`; concurrent operations carry explicit calls so identities cannot leak between requests.

### Credential lifecycle framework

`dsh-auth` defines credential and token-family lifecycle contracts without implementing token encoding, signing, storage, or transport. Concrete Providers own issued secret values and persistence. TTLs, key rotation, algorithms, issuers, audiences, and storage backends are Provider configuration rather than constants in the L1 package.

The common lifecycle distinguishes access credentials, refresh credentials, API keys, and local attestations by credential kind and capability. Providers may register issue, refresh, inspect, and revoke operations that their credential kind supports; unsupported operations fail explicitly. `dsh-auth` normalizes lifecycle results and events but does not require API keys or local attestations to imitate refresh tokens.

The refresh contract requires one-time refresh-token rotation. A successful refresh atomically consumes the presented refresh credential and returns a new access credential plus a new refresh credential in the same token family. Concurrent use of one refresh credential permits at most one success. Reuse of a consumed refresh credential reports compromise and revokes the token family. Providers persist only a one-way verifier for refresh secrets and return a plaintext refresh value only at issuance or rotation.

Revocation addresses an individual credential, a token family, or all credentials for one principal. The contract reports whether access-credential revocation is immediate or bounded by expiry; a stateless access token cannot claim immediate revocation unless its Provider checks a denylist, credential version, or online authority. `dsh-auth` does not choose between those implementations.

### Secret handling and events

Raw credentials are short-lived inputs to Providers and lifecycle operations. They never enter `AuthenticatedCall`, error messages, Cordis events, logs owned by this package, model requests, session events, or audit metadata. Credential return values are explicit secret-bearing results so Consumers can avoid generic serialization and logging helpers.

The package emits bounded `auth/succeeded`, `auth/failed`, `auth/credential-revoked`, `auth/token-rotated`, and `auth/token-reuse-detected` events. Events may contain request id, principal kind and id after successful identification, method, credential id, token-family id, outcome, safe reason, and time. They contain no raw credentials, Provider claims, password material, resource contents, roles, or tenant data. These live events support a later security-audit Consumer and never enter the session replay log.

### Package dependencies and downstream use

`dsh-auth` depends on Cordis and the repository's branded-id utility, with no JWT, database, HTTP framework, Redis, tenant, or authorization dependency. A test-only fixture Provider proves registry, provenance, lifecycle, and failure behavior without becoming a production fallback.

`dsh-auth-jwt` will consume the contracts to implement access and rotating refresh tokens. `dsh-auth-apikey` will implement API-key verification and revocation without refresh behavior. `dsh-tenant-scope` will consume a current authenticated call plus membership state to derive `TenantScope`. `dsh-authority` will consume a current call and, where required, a tenant scope to evaluate product permissions. `dsh-auth-gateway` will own HTTP, WebSocket, SDK, ACP, and in-process evidence extraction, public status mapping, and Host-only call propagation.

The initial `dsh-auth` change does not modify Gateway handlers, Typert descriptors, Remote decorators, API Proxy route permissions, session records, MySQL, Redis, Elasticsearch, Kafka, or shipped bundle behavior. Those integrations require their own Agent Notes and complete Provider/Consumer composition.

The resulting P0 package therefore has low immediate blast radius but no standalone security claim. It gives later plugins one identity representation, deterministic Provider selection, shared expiry and provenance checks, and common secret handling. The cost is more packages and explicit composition, while real login and protected product operations remain unavailable until a concrete Provider and transport Consumer are installed. The proposed [Provider and Consumer composition](2026-08-23-dsh-auth-provider-and-consumer-composition.md) records that integration path.

## Alternatives considered

**Combine authentication and authorization in one package.** Rejected because credential verification and product policy have different Providers, failure states, storage, and change frequency. A valid identity must not imply permission.

**Put tenant and membership scope in `AuthenticatedCall`.** Rejected because one principal may have several memberships, tenant selection can vary per operation, and membership can change independently of credential validity. `dsh-tenant-scope` owns that derivation.

**Let every transport or Provider construct its own authenticated-call object.** Rejected because provenance, immutability, expiry, cancellation, failure mapping, and secret handling would diverge, while structural objects could cross an unintended trust path.

**Try all registered Providers until one accepts a credential.** Rejected because ambiguous ownership, variable timing, and Provider outages would produce unsafe fallback behavior. Evidence kind selects one Provider exactly.

**Include JWT signing and refresh persistence in `dsh-auth`.** Rejected because JWT and API keys have different lifecycle capabilities and dependencies. The L1 package owns common obligations; L2 packages own formats, cryptography, persistence, and deployment configuration.

**Use a global current-user service.** Rejected because concurrent requests and nested asynchronous work could observe the wrong identity. Calls remain explicit Host-only values.

**Activate a permissive local Provider from the core package.** Rejected because a silent local fallback would turn missing deployment authentication into trusted access. Local development may use a separate explicit Provider or test fixture.

## Acceptance criteria

- `@deepseek-ai/dsh-auth` defines branded principal, credential, token-family, request, and method identifiers without importing authorization or tenant packages.
- Provider registration is effect-owned, rejects duplicate evidence-kind ownership, selects exactly one Provider, and fails closed when verification cannot complete.
- The service alone mints frozen authenticated calls and rejects structural copies, JSON round trips, foreign issuers, disposed registrations, cancelled calls, and expired calls.
- Authentication and lifecycle failures expose stable public categories without returning credential values, account-existence details, Provider diagnostics, or arbitrary claims.
- Credential lifecycle contracts cover issuance, inspection, atomic refresh rotation, reuse detection, individual and family revocation, and principal-wide revocation while allowing credential kinds to declare unsupported operations.
- Sanitized events contain correlation and identity metadata but no secrets, roles, tenant scope, resource content, or model-visible data.
- Focused unit tests cover identifier validation, registry lifecycle, Provider failure, exact-object provenance, immutability, expiry, cancellation, rotation races, reuse detection, revocation, event redaction, and Provider disposal.
- The P0 package change does not alter existing Remote signatures, transport behavior, business plugin behavior, or shipped bundle composition.

## Risks

- A broad generic lifecycle API could force JWT concepts onto API keys and local identity. Capability-specific operations and explicit unsupported results must keep credential kinds distinct.
- Process-private provenance protects same-process calls but does not cross a process boundary. A later control-plane assertion requires its own signed wire format and audience validation before a receiving Host mints a local call.
- Immediate access-token revocation conflicts with stateless verification. Provider capability metadata and documentation must state the actual revocation delay instead of promising stronger behavior.
- A registry keyed only by carrier syntax can become ambiguous when several mechanisms use bearer tokens. Evidence extraction must select a configured authentication method or issuer route without sequential Provider probing.
- Deferring tenant scope and authorization keeps P0 small but means the package alone does not secure a product operation. No deployment should claim authenticated access until a concrete Provider and transport Consumer are composed.
