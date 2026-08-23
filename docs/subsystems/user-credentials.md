# User Credentials

English | [中文](user-credentials.zh.md)

The user-credentials subsystem is [`@deepseek-ai/dsh-user-credential`](../../packages/identity/user-credential/README.md), a Host-only Service Definition for login identifier lookup and password verification mapped to stable `UserId` values. A concrete Provider supplies `ctx.userCredentials`; profile lifecycle, authenticated-call provenance, authorization, transport, and storage retain separate owners.

## Identifier semantics

An identifier is an extensible `(kind, value)` pair. The Provider owns kind-specific normalization and global uniqueness of the normalized pair. Add, remove, and resolve normalize inside the enforcing operation. Trusted metadata reads expose normalized values; events never expose them.

## Password semantics

Password secrets enter only Provider methods and never appear in metadata or events. A Provider owns verifier derivation and storage and performs comparable dummy verifier work for missing accounts and disabled passwords. Public verification collapses missing, disabled, and incorrect credentials to `false`.

## Concurrency and events

Identifiers and password state share one aggregate revision. Every mutation compares `expectedRevision`, commits atomically, increments by one, and returns a metadata-only before-and-after proof. The service validates the proof before emitting `user-credential/changed` after commit.

## Composition

Authentication Consumers resolve an identifier, verify its credential, then require the resulting user to be active through `ctx.users` before issuing an authenticated call. Administrative Consumers authenticate and authorize the actor before mutations; operation context supplies audit metadata but proves no permission.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxusercredentials--usercredentialservice-abstract-seam"></a>

### `ctx.userCredentials` — `UserCredentialService` (abstract seam)

Abstract credential service. Providers own normalization, uniqueness, verifier storage, dummy verification, and atomic revision checks.

```ts cordis-catalog
/** Normalize one raw login identifier.
 * @param input - extensible kind and raw value.
 * @returns immutable canonical identifier.
 */
async normalize(input: LoginIdentifierInput): Promise<LoginIdentifier>

/** Read detached non-secret metadata for one user.
 * @param userId - stable target user id.
 * @returns immutable metadata, or undefined when no aggregate exists.
 */
async get(userId: UserId): Promise<UserCredentialRecord | undefined>

/** Resolve a raw login identifier to its user, or undefined.
 * @param input - extensible kind and raw value.
 * @returns stable user id, or undefined when no identifier matches.
 */
async resolve(input: LoginIdentifierInput): Promise<UserId | undefined>

/** List login identifiers and password-state metadata for one user.
 * @param userId - stable target user id.
 * @returns immutable metadata, or undefined when no aggregate exists.
 */
list(userId: UserId): Promise<UserCredentialRecord | undefined>

/** Add one globally unique normalized login identifier.
 * @param request - target, revision, raw identifier, and audit context.
 * @returns immutable committed metadata.
 */
async addIdentifier(request: AddLoginIdentifierRequest): Promise<UserCredentialRecord>

/** Remove one normalized login identifier.
 * @param request - target, revision, raw identifier, and audit context.
 * @returns immutable committed metadata.
 */
async removeIdentifier(request: RemoveLoginIdentifierRequest): Promise<UserCredentialRecord>

/** Establish or administratively replace a password.
 * @param request - target, revision, new password, and audit context.
 * @returns immutable committed metadata without password material.
 */
async setPassword(request: SetPasswordRequest): Promise<UserCredentialRecord>

/** Atomically verify the current password and replace it.
 * @param request - target, revision, current and new passwords, and audit context.
 * @returns immutable committed metadata without password material.
 */
async changePassword(request: ChangePasswordRequest): Promise<UserCredentialRecord>

/** Disable password login without exposing or returning verifier material.
 * @param request - target, revision, and audit context.
 * @returns immutable committed metadata with password login disabled.
 */
async disablePassword(request: DisablePasswordRequest): Promise<UserCredentialRecord>

/** Verify a password with an enumeration-resistant boolean result.
 * @param request - target user and candidate password.
 * @returns true only for a matching enabled password; otherwise false.
 */
async verifyPassword(request: VerifyPasswordRequest): Promise<boolean>
```

Types: [UserId](user-directory.md)

Source: [`packages/identity/user-credential/src/index.ts:207`](../../packages/identity/user-credential/src/index.ts)

<a id="user-credential-events"></a>

### `user-credential/*` events

<a id="user-credentialchanged--emit"></a>

#### `user-credential/changed` — emit

Committed credential metadata change without identifiers or password material.

```ts cordis-catalog
/**
 * Committed credential metadata change without identifiers or password material.
 * @param event - sanitized fact safe for trusted audit listeners.
 * @mode emit
 */
'user-credential/changed'(event: UserCredentialChangeEvent): void
```

Source: [`packages/identity/user-credential/src/types.ts:129`](../../packages/identity/user-credential/src/types.ts)
<!-- END GENERATED cordis-surface -->
