# @deepseek-ai/dsh-user-credential

English | [中文](README.zh.md)

Provider-independent Host service for login identifiers and password credentials mapped to [`UserId`](../user/README.md). It owns the operations that maintain how a human user logs in; [`dsh-user`](../user) remains the owner of profile and account lifecycle state.

This package is a Service Definition. It creates no table and implements no password hashing algorithm. A deployment mounts one concrete Provider as `ctx.userCredentials`; that Provider owns identifier normalization and uniqueness, password verifier storage, hashing parameters, constant-work dummy verification, transactions, and durable data.

## Public API

| API | Purpose |
|---|---|
| `normalize(input)` | Canonicalize one raw identifier using rules for its extensible `kind` |
| `addIdentifier(request)` | Add one globally unique normalized identifier using `expectedRevision` |
| `removeIdentifier(request)` | Remove one normalized identifier using `expectedRevision` |
| `resolve(input)` | Resolve a raw identifier to `UserId`, or return `undefined` |
| `get(userId)` / `list(userId)` | Return detached identifier and password-state metadata, or `undefined` |
| `setPassword(request)` | Establish or administratively replace a password |
| `changePassword(request)` | Verify the current password and replace it atomically |
| `verifyPassword(request)` | Return only `true` or `false` for one user and password |
| `disablePassword(request)` | Disable password login and remove active verifier state |

`username`, `email`, and later identifier kinds share the same API. The active Provider defines the normalization for each supported kind and fails unsupported kinds explicitly. Callers use `normalize()` only for previews and validation; add, remove, and resolve always normalize again at the operation that enforces uniqueness or performs lookup.

## Credential Metadata and Revision

`UserCredentialRecord` contains `userId`, aggregate `revision`, normalized identifier metadata, `passwordEnabled`, timestamps, and no password material. The list is capped at 32 identifiers. Raw and normalized values are capped at 320 UTF-8 bytes; passwords are capped at 1024 UTF-8 bytes before entering a Provider.

Revision zero means no credential aggregate exists yet. The first identifier or password operation compares against zero and commits revision 1. Every later identifier or password mutation atomically compares `expectedRevision` and increments it by one. One shared revision prevents simultaneous password and identifier administration from silently overwriting each other.

The base service validates and freezes returned metadata and verifies the Provider's before-and-after commit proof. Identifier values appear in trusted `get`, `list`, and `resolve` results because account management needs them. They never appear in change events, password results, or Provider diagnostics returned by this package.

## Implementing a Provider

A Provider subclasses `UserCredentialService` and implements five protected operations: normalize one identifier, read metadata, resolve a normalized identifier, atomically mutate credentials, and verify a password. `mutateCredentialRecord()` receives secrets only for password mutations and returns metadata only. Hashes, salts, pepper references, verifier versions, and dummy hashes remain private Provider state.

`verifyPasswordSecret()` performs comparable password-verifier work for an unresolved identifier, an unknown user, a user without a password, and an incorrect password. The public `verifyPassword()` accepts an omitted `userId` and returns `false` for all credential failures, so callers cannot enumerate account or password state from its result. A `dsh-auth-password` Consumer must call `verifyPassword({ password })` after `resolve()` returns `undefined`; it must not return early and skip the Provider's dummy verifier. Unexpected Provider failures become a fixed `provider-unavailable` error; Provider messages, causes, diagnostics, and secrets never cross the service API.

Expected storage failures use `UserCredentialError`: `identifier-conflict`, `identifier-not-found`, `password-not-set`, `invalid-credential`, and `revision-conflict`. The public `@deepseek-ai/dsh-user-credential/testing` entry exports the normative framework-neutral Provider suite. Each Provider supplies a fresh harness and an explicit password-verification work probe, then runs that suite alongside storage-specific durability, hashing, timing, and transaction tests.

## Authorization and Account Lifecycle

This service does not decide whether a caller may reset a password or edit another user's identifiers. Self-service and administrative Consumers authenticate the actor, require the relevant RBAC permission, require the target user to be active through `ctx.users`, then call `ctx.userCredentials` with the target `userId`, expected revision, and optional audit context.

Disabling or deleting a user in `dsh-user` does not implicitly mutate credential storage. Authentication composition checks account lifecycle before issuing an authenticated call, while a dedicated Consumer may react to `user/changed` and revoke sessions or disable login methods according to deployment policy.

## Events

Every successful mutation emits `user-credential/changed` after commit. It contains change kind, `userId`, revision, Provider time, and optional actor, correlation, and reason metadata. It excludes identifier kind and value, passwords, verifier material, and storage diagnostics. Listener failures cannot roll back committed credential data; synchronous invariant failures remain fatal after all listeners run.

## Failure Semantics

| Code | Meaning |
|---|---|
| `invalid-input` | Identifier syntax, size, password size, revision, id, or audit context is invalid |
| `credential-not-found` | No aggregate exists for a metadata or mutation operation that requires one |
| `identifier-conflict` | The normalized `(kind, value)` already belongs to a user |
| `identifier-not-found` | The requested normalized identifier is absent from the target user |
| `password-not-set` | Password login is not enabled for the requested mutation |
| `invalid-credential` | `changePassword()` did not verify the current password |
| `revision-conflict` | Credential metadata changed after the caller read it |
| `provider-unavailable` | The Provider failed unexpectedly or returned invalid metadata |

Login transports collapse identifier absence and password failure into the same public authentication response. `resolve()` is intended for trusted authentication and administration Consumers, not an unauthenticated account-discovery endpoint.

## Model Experience

### User credential state

#### What the model sees

Nothing. `ctx.userCredentials` identifiers, password operations, metadata, and events are Host-only; this package registers no prompt section, tool, or Session event.

#### Token effect

Zero. Credential operations do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Credential changes do not alter a model-visible request prefix and cannot invalidate an otherwise reusable Provider cache entry.

## Known Limitations and Deferred Work

- **No production Provider** - a persistence package must choose normalization rules, hashing library and parameters, schema, migrations, indexes, transactions, dummy verifier, and database error classification.
- **No registration or recovery workflow** - email verification, password policy, reset challenges, lockout, MFA, and product routes belong to dedicated Consumers and Providers.
- **No automatic lifecycle reaction** - user disablement, deletion, and session revocation require explicit composition with `dsh-user`, authentication, and token/session plugins.
- **No durable audit delivery** - the live change event is process-local; a persistent Provider owns a transactional outbox when external delivery is required.
