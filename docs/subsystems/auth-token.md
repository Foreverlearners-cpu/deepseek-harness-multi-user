# Auth Token Families

English | [中文](auth-token.zh.md)

The auth-token subsystem is [`@deepseek-ai/dsh-auth-token`](../../packages/identity/auth-token/README.md), a Host-only Service Definition for opaque refresh-token family state. It complements [`dsh-auth`](authentication.md): authentication establishes a principal and dispatches a credential Provider, while this service gives JWT and other token Providers one reusable rotation and revocation model.

## Secret ownership

The service generates each refresh secret and returns it only from `issueFamily` or `rotate`. Provider hooks receive a SHA-256 `RefreshTokenDigest`; inspection and events remove both secret and digest. A storage Provider persists digest rows, and a transport Consumer decides how the returned secret reaches the client.

## Atomic lifecycle

A family has one absolute expiry and a monotonic revision. Creation starts at revision 1. Rotation atomically marks the current credential `rotated`, inserts one `active` replacement, and increments revision. Reuse of a rotated digest atomically revokes the family before the call fails. Revocation by credential, family, or principal is idempotent.

## Provider and Consumer composition

A concrete Provider supplies `ctx.authTokens` and owns transactions, locking, indexes, and durability. A JWT Provider separately owns access-token signing and verification, then combines its access credential with the refresh credential returned here. HTTP and gateway Consumers own bearer or cookie parsing, CSRF policy, and public error mapping.

## Audit

`auth-token/changed` is a post-commit, process-local event for trusted audit and invalidation Consumers. It includes stable ids, principal, revision, status, time, and reason but excludes credential material and Provider diagnostics. Durable audit delivery requires a Provider-owned transactional outbox.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthtokens--authtokenservice-abstract-seam"></a>

### `ctx.authTokens` — `AuthTokenService` (abstract seam)

Abstract opaque refresh-token lifecycle. Providers own durable state and atomic commits; this base owns secrets, digests, validation, and events.

```ts cordis-catalog
/**
 * Atomically create one family and its first opaque refresh credential.
 * @param request - authenticated principal, absolute expiry, and operation lifecycle.
 * @returns committed safe family metadata and the only copy of the refresh secret.
 */
async issueFamily(request: TokenFamilyIssueRequest): Promise<TokenFamilyIssueResult>

/**
 * Atomically consume one refresh token and replace it exactly once.
 * Reuse revokes the entire family before the method rejects.
 * @param request - current refresh secret, replacement expiry, and operation lifecycle.
 * @returns committed family metadata and a replacement refresh secret.
 */
async rotate(request: RefreshTokenRotateRequest): Promise<TokenFamilyIssueResult>

/**
 * Inspect safe family and refresh-credential metadata.
 * @param request - credential, family, or principal target and operation lifecycle.
 * @returns immutable metadata without refresh secrets or digests.
 */
async inspect(request: AuthTokenInspectRequest): Promise<AuthTokenInspection>

/**
 * Idempotently revoke the family selected by a credential or family target,
 * or every active family belonging to one principal.
 * @param request - revocation target and operation lifecycle.
 */
async revoke(request: AuthTokenRevokeRequest): Promise<void>
```

Source: [`packages/identity/auth-token/src/index.ts:267`](../../packages/identity/auth-token/src/index.ts)

<a id="auth-token-events"></a>

### `auth-token/*` events

<a id="auth-tokenchanged--emit"></a>

#### `auth-token/changed` — emit

Committed token-family change without refresh secrets or digests.

```ts cordis-catalog
/**
 * Committed token-family change without refresh secrets or digests.
 * @param event - sanitized lifecycle fact safe for trusted audit listeners.
 * @mode emit
 */
'auth-token/changed'(event: AuthTokenChangeEvent): void
```

Source: [`packages/identity/auth-token/src/types.ts:216`](../../packages/identity/auth-token/src/types.ts)
<!-- END GENERATED cordis-surface -->
