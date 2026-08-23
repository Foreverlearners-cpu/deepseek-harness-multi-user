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

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
