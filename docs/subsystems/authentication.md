# Authentication

English | [中文](authentication.zh.md)

The authentication subsystem is [`@deepseek-ai/dsh-auth`](../../packages/identity/auth/README.md), a Host-only runtime that selects one Provider for submitted evidence, records verified principal facts in an immutable `AuthenticatedCall`, and dispatches optional credential lifecycle operations to the Provider that owns the authentication method. It establishes identity only; authorization and tenant derivation remain separate consumers.

## Provider selection

Trusted transport adapters submit one `AuthenticationAttempt`. Its evidence kind selects exactly one registered Provider; duplicate evidence-kind or authentication-method registrations fail during registration. Providers validate their own raw credentials and return identity facts without exposing credential material to the runtime event stream.

## Call provenance

`authenticate()` creates an immutable `AuthenticatedCall` and records its live Provider registration in process-local provenance. `assertCurrent()` accepts only that exact object while its Provider remains registered, its signal remains active, and its expiry has not passed. Serialization or copying cannot preserve provenance.

## Credential lifecycle

Providers may implement issue, refresh, inspect, and revoke operations for credentials they own. The runtime routes each operation by authentication method, validates issued credential metadata, and rejects unsupported operations without guessing another Provider.

## Audit event

`auth/result` reports the request identity, selected method, verified principal, outcome, and safe failure category. It never contains raw evidence or issued credential values.

## Account orchestration

`ctx.accounts` coordinates durable registration, password login, JWT refresh/logout, and self-service profile/password changes. Registration returns a `UserRecord`; callers log in separately to receive the access/refresh JWT pair. Before registration can write, composition must install exactly one durable `RegistrationOperationProvider` with `ctx.accounts.registrationOperations.register(provider)`. The Provider persists the request-id keyed `begin`/`advance`/`complete` state machine and exposes `read` for recovery tooling. Missing persistence fails closed, completed retries return the same non-secret user result, and partial commits report an `AccountRecoveryState` without passwords or tokens.

Password login fences JWT issuance with credential metadata. The account service resolves and reads the credential revision before password authentication, then reads it again after issuing the JWT pair. A changed owner, revision, or password-enabled state causes the newly issued token family to be revoked and the login to fail, so a concurrent password reset cannot leave a successful stale login.

Self-service profile updates accept only `displayName`; extension writes remain an administrator capability. All administrator methods live on the separate `ctx.accountAdministration` service. Composition must install exactly one `AccountAdminAuthorizer` with `ctx.accountAdministration.authorizers.register(authorizer)`. Every call passes the current actor, exact action, and optional target to that authorizer, and a missing or rejecting authorizer returns `forbidden` without performing the mutation.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccountadministration--accountadministrationservice"></a>

### `ctx.accountAdministration` — `AccountAdministrationService`

Explicit administrator capability guarded by one fail-closed authorizer.

```ts cordis-catalog
/** Create an account after explicit administrator authorization.
 * @param request - actor and registration input.
 * @returns committed account record.
 */
async adminCreate(request: AdminAccountCreateRequest): Promise<UserRecord>

/** Update a target after explicit administrator authorization.
 * @param request - actor, target, revision, and patch.
 * @returns committed target record.
 */
async adminUpdate(request: AdminAccountUpdateRequest): Promise<UserRecord>

/** Disable a target after explicit administrator authorization.
 * @param request - actor, target, revision, and lifecycle.
 * @returns committed disabled target.
 */
async adminDisable(request: AdminAccountStatusRequest): Promise<UserRecord>

/** Enable a target after explicit administrator authorization.
 * @param request - actor, target, revision, and lifecycle.
 * @returns committed active target.
 */
async adminEnable(request: AdminAccountStatusRequest): Promise<UserRecord>

/** Reset a target password after explicit administrator authorization.
 * @param request - actor, target, revision, and new password.
 * @returns committed credential metadata.
 */
async adminResetPassword(request: AdminPasswordResetRequest): Promise<UserCredentialRecord>

/** Revoke target sessions after explicit administrator authorization.
 * @param request - actor, target, and lifecycle.
 */
async adminRevokeSessions(request: AdminSessionRevokeRequest): Promise<void>
```

Types: [UserCredentialRecord](user-credentials.md) · [UserRecord](user-directory.md)

Source: [`packages/identity/account/src/index.ts:818`](../../packages/identity/account/src/index.ts)

<a id="ctxaccounts--accountservice"></a>

### `ctx.accounts` — `AccountService`

Coordinates users, credentials, authentication, and JWT lifecycle operations.

```ts cordis-catalog
/** Idempotently register one active account.
 * @param request - profile, identifier, secret, and operation lifecycle.
 * @returns the same committed user for every completed retry.
 */
async register(request: AccountRegistrationInput): Promise<UserRecord>

/** Authenticate a password, require an active user, and issue a JWT pair.
 * @param request - trusted transport login request.
 * @returns active user plus newly issued credentials.
 */
async login(request: AccountLoginRequest): Promise<AccountSessionResult>

/** Rotate a JWT refresh credential.
 * @param request - refresh secret and operation lifecycle.
 * @returns replacement access and refresh credentials.
 */
async refresh(request: AccountRefreshRequest): Promise<IssuedCredentialSet>

/** Revoke every JWT session owned by the current user.
 * @param call - exact current authenticated call.
 */
async logout(call: AuthenticatedCall): Promise<void>

/** Update the current user's profile with optimistic concurrency.
 * @param request - current call, expected revision, and profile patch.
 * @returns committed user record.
 */
async updateProfile(request: AccountProfileUpdateRequest): Promise<UserRecord>

/** Change the current user's password and revoke all existing JWT sessions.
 * @param request - current call, revision, old/new secrets, and lifecycle.
 * @returns committed non-secret credential metadata.
 */
async changePassword(request: AccountPasswordChangeRequest): Promise<UserCredentialRecord>
```

Types: [UserCredentialRecord](user-credentials.md) · [UserRecord](user-directory.md)

Source: [`packages/identity/account/src/index.ts:152`](../../packages/identity/account/src/index.ts)

<a id="ctxauth--authenticationruntime"></a>

### `ctx.auth` — `AuthenticationRuntime`

Authentication service that selects Providers and exclusively mints calls.

```ts cordis-catalog
/**
 * Verify carrier evidence through its sole Provider and mint an immutable call.
 * @param attempt - Host-owned request facts and untrusted carrier evidence.
 * @returns request identity accepted only by this live runtime.
 */
async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticatedCall>

/**
 * Require an exact call issued by this runtime whose request and Provider remain current.
 * @param value - candidate Host-only call.
 * @returns the same immutable call after validation.
 */
assertCurrent(value: unknown): AuthenticatedCall
```

Source: [`packages/identity/auth/src/index.ts:303`](../../packages/identity/auth/src/index.ts)

<a id="ctxauthgateway--authgatewayservice"></a>

### `ctx.authGateway` — `AuthGatewayService`

Extracts bounded credentials and delegates only public account operations.

```ts cordis-catalog
/** Authenticate one HTTP access carrier.
 * @param request - structured headers, cookies, query, and lifecycle.
 * @returns Host-only call minted by the active authentication Provider.
 */
async authenticateHttp(request: GatewayHttpAuthenticationRequest): Promise<AuthenticatedCall>

/** Authenticate one WebSocket handshake without retaining raw carrier input.
 * @param request - structured handshake fields and lifecycle.
 * @returns Host-only call minted for the WebSocket channel.
 */
async authenticateWebSocket(request: GatewayWebSocketAuthenticationRequest): Promise<AuthenticatedCall>

/** Register an account without issuing credentials.
 * @param request - bounded profile, password, and lifecycle input.
 * @returns committed user record.
 */
async register(request: GatewayRegistrationRequest): Promise<UserRecord>

/** Password-login and place refresh material in an HttpOnly cookie.
 * @param request - bounded login body and lifecycle input.
 * @returns user, access token, and cookie directives.
 */
async login(request: GatewayLoginRequest): Promise<GatewaySessionResult>

/** Rotate the refresh cookie after Origin and double-submit CSRF checks.
 * @param request - structured browser request and lifecycle.
 * @returns replacement access token and cookie directives.
 */
async refresh(request: GatewayRequest): Promise<GatewaySessionResult>

/** Authenticate and revoke the current user's sessions.
 * @param request - HTTP bearer request and lifecycle.
 * @returns cookie clearing directives.
 */
async logout(request: GatewayHttpAuthenticationRequest): Promise<GatewayLogoutResult>

/** Revalidate an authenticated call immediately before protected handler use.
 * @param call - exact Host-only call returned by this gateway.
 * @param handler - protected operation that receives only the current call.
 * @returns handler result.
 */
guard<T>(call: AuthenticatedCall, handler: (current: AuthenticatedCall) => T | Promise<T>): T | Promise<T>
```

Types: [UserRecord](user-directory.md)

Source: [`packages/identity/auth-gateway/src/index.ts:185`](../../packages/identity/auth-gateway/src/index.ts)

<a id="account-events"></a>

### `account/*` events

<a id="accountchanged--emit"></a>

#### `account/changed` — emit

Completed account orchestration fact without credential material.

```ts cordis-catalog
/**
 * Completed account orchestration fact without credential material.
 * @param event - sanitized account operation safe for audit listeners.
 * @mode emit
 */
'account/changed'(event: AccountChangeEvent): void
```

Source: [`packages/identity/account/src/types.ts:205`](../../packages/identity/account/src/types.ts)

<a id="auth-events"></a>

### `auth/*` events

<a id="authresult--emit"></a>

#### `auth/result` — emit

Completed authentication result without raw credential material.

```ts cordis-catalog
/**
 * Completed authentication result without raw credential material.
 * @param record - sanitized result safe for audit listeners.
 * @mode emit
 */
'auth/result'(record: AuthenticationEventRecord): void
```

Source: [`packages/identity/auth/src/types.ts:164`](../../packages/identity/auth/src/types.ts)
<!-- END GENERATED cordis-surface -->
