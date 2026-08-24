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

`ctx.accounts` coordinates user, password-credential, and JWT lifecycle services for Host-only registration, login, self-service, and administrator operations. It preserves each owning service's optimistic revision checks, reports non-secret recovery state after partial commits, and requires trusted Consumers to authorize administrator calls before invocation.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccounts--accountservice"></a>

### `ctx.accounts` — `AccountService`

Coordinates users, credentials, authentication, and JWT lifecycle operations.

```ts cordis-catalog
/** Register an active account and issue its first JWT pair.
 * @param request - profile, identifier, secret, and operation lifecycle.
 * @returns committed user plus newly issued credentials.
 */
async register(request: AccountRegistrationInput): Promise<AccountSessionResult>

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

/** Create an account after the trusted caller authorizes the administrator.
 * @param request - authorized actor and new account values.
 * @returns committed account record without issued credentials.
 */
async adminCreate(request: AdminAccountCreateRequest): Promise<UserRecord>

/** Update a profile after the trusted caller authorizes the administrator.
 * @param request - authorized actor, target, revision, and patch.
 * @returns committed target record.
 */
async adminUpdate(request: AdminAccountUpdateRequest): Promise<UserRecord>

/** Disable a target and revoke all sessions after caller authorization.
 * @param request - authorized actor, target revision, reason, and lifecycle.
 * @returns committed disabled record.
 */
async adminDisable(request: AdminAccountStatusRequest): Promise<UserRecord>

/** Enable a target after caller authorization.
 * @param request - authorized actor, target revision, and reason.
 * @returns committed active record.
 */
async adminEnable(request: AdminAccountStatusRequest): Promise<UserRecord>

/** Reset a target password and revoke all sessions after caller authorization.
 * @param request - authorized actor, target credential revision, and new secret.
 * @returns committed non-secret credential metadata.
 */
async adminResetPassword(request: AdminPasswordResetRequest): Promise<UserCredentialRecord>

/** Revoke a target user's JWT sessions after caller authorization.
 * @param request - authorized actor, target, reason, and lifecycle.
 */
async adminRevokeSessions(request: AdminSessionRevokeRequest): Promise<void>
```

Types: [UserCredentialRecord](user-credentials.md) · [UserRecord](user-directory.md)

Source: [`packages/identity/account/src/index.ts:67`](../../packages/identity/account/src/index.ts)

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

Source: [`packages/identity/account/src/types.ts:149`](../../packages/identity/account/src/types.ts)

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
