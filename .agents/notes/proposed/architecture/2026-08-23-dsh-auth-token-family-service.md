# Agent Note: dsh-auth-token family service

Status: proposed

English | [中文](2026-08-23-dsh-auth-token-family-service.zh.md)

## Problem

JWT and other bearer-token Providers need refresh-token rotation, compromise detection, principal-wide revocation, and safe inspection. Implementing that state machine inside every token format would duplicate concurrency and redaction rules, while placing it in `dsh-auth` would couple process-local evidence verification to durable token state.

Refresh secrets are bearer credentials. Durable plaintext storage or non-atomic consume-and-replace operations can expose a family or let concurrent rotations both succeed. The shared service must define Provider commit obligations without owning JWT encoding, HTTP transport, or a database.

## Proposal

Add `@deepseek-ai/dsh-auth-token` as a Host-only Service Definition at `ctx.authTokens`. It owns high-entropy opaque refresh-secret generation, SHA-256 digest derivation, family records, validation, stable failures, redacted post-commit events, and a shared Provider suite. It reuses `AuthenticatedPrincipal`, `AuthenticationRequestId`, `CredentialId`, `TokenFamilyId`, and `UserId` from `dsh-auth` instead of redeclaring identities.

The public operations are `issueFamily`, `rotate`, `inspect`, and `revoke`. JWT Providers separately own access-token signing and verification and may expose the operations through `dsh-auth`'s credential lifecycle capability. A later MySQL Provider owns schema, transactions, locks, indexes, migrations, and a transactional outbox.

JWT composition has an explicit failure boundary. A JWT Provider resolves and validates its signing key and prepares every potentially failing signing dependency before a refresh-family issue or rotation commit. Signing after that commit must be a non-failing in-memory operation. A Provider that cannot guarantee this must synchronously revoke the newly committed family as compensation before surfacing the signing failure; this package does not perform JWT signing or that orchestration itself.

## Secret handling

The base service generates each refresh secret from at least 32 random bytes. Plaintext is a short-lived input or return value only. Provider hooks receive a fixed SHA-256 digest; durable records, inspection, events, errors, and diagnostics cannot represent plaintext. SHA-256 is sufficient because these tokens have at least 256 bits of uniform entropy and are not user-selected passwords. Providers apply a unique digest index and do not log digests.

Refresh-token input is limited to 4 KiB of UTF-8 data before hashing or Provider work.

## State, revision, and expiry

`TokenFamilyRecord` has an `active` or `revoked` status, absolute expiry, and monotonic revision. Revision starts at 1 and increments once for each committed rotation or first revocation. Repeat revocation is idempotent. Revision orders audit and cache changes; public revocation does not require an expected revision because urgent invalidation must survive concurrent rotation.

`RefreshCredentialRecord` has an `active`, `rotated`, or `revoked` status plus issue, expiry, rotation, replacement, and revocation facts. Family expiry is established at issue. Each replacement inherits that exact expiry from the family record read inside the Provider transaction; the opaque refresh value neither reveals nor lets its caller select durable family state.

## Atomic rotation and reuse

The Provider locks the digest, checks family and credential expiry and state, consumes an active credential, inserts one active replacement, and increments family revision in one transaction. The commit returns the consumed rotated credential and replacement so the base validates ids, digest, timestamps, family relation, and revision before returning the new secret.

A matched rotated digest is reuse. The Provider revokes the active family and every active credential in the same transaction, records `refresh-token-reuse`, increments revision, and returns the reuse commit. The base emits `reuse-detected` and then throws `refresh-token-reused`. An already revoked family fails without another revision change.

Unknown, expired, reused, and revoked states have distinct internal error codes. Transport Consumers may collapse them when exposing the distinction would aid probing.

## Inspection, revocation, and events

Inspection targets a refresh Credential, family, or principal and removes digest from its result. Returned records must be provably bound to that target. Credential-target revocation revokes its family because retaining sibling refresh credentials would violate family compromise semantics, and its commit includes the matched Credential as proof of the Credential-to-family relation. Principal revocation changes every active family in one Provider transaction.

`auth-token/changed` is emitted only after issue, rotation, explicit revocation, or reuse revocation commits. It carries stable ids, principal, revision, status, time, and reason but no secret, digest, access token, claim, or Provider diagnostic. Every listener failure, including an invariant failure, is logged and contained after commit; durable audit requires a Provider-owned transactional outbox.

## Alternatives considered

**Store refresh state in `dsh-auth`.** Rejected because evidence verification and authenticated-call provenance are process-local, while refresh families need durable transactions and independent compromise policy.

**Let every JWT Provider implement rotation.** Rejected because token encoding does not change the one-time refresh state machine, and duplicate implementations would drift on reuse and redaction.

**Persist encrypted refresh secrets.** Rejected because verification needs equality, not recovery. A digest of a high-entropy value limits disclosure and removes encryption-key lifecycle.

**Let a rotation caller choose replacement expiry.** Rejected because an opaque refresh value does not reveal the family expiry, so the caller cannot select a valid bound without an extra lookup key. Caller-selected expiry could also shorten a family accidentally or enable sliding renewal. The Provider copies the fixed family expiry while it holds the rotation lock.

**Require expected revision for revocation.** Rejected because concurrent rotation must not prevent administrative or compromise-driven invalidation.

## Acceptance criteria

- Provider hooks receive refresh digests but never plaintext secrets.
- Rotation is atomic; only one concurrent use succeeds.
- Reuse atomically revokes the family before returning its stable failure.
- Family revision and absolute expiry are validated on Provider commits.
- Inspection and revocation results are bound to their requested target.
- Post-commit listener failures never make lifecycle operations fail.
- JWT composition prepares signing before commit or compensates by synchronously revoking the committed family.
- Inspection and events exclude secrets, digests, access tokens, claims, and diagnostics.
- Revocation supports Credential, family, and principal targets and is idempotent.
- The shared suite covers issue, rotation, reuse, expiry, inspection, redaction, and revocation.
- The package imports no JWT implementation, transport, MySQL, Session, tenant, or authorization package.

## Risks

- Abstract hooks cannot prove backend transaction isolation; each Provider needs real concurrent transaction tests in addition to the shared suite.
- Process-local events cannot guarantee durable audit delivery; persistence Providers need a transactional outbox for that requirement.
- Distinct internal failures reveal state if mapped directly to hostile clients; transport adapters own error collapsing.
- Digest safety depends on generated entropy; Consumers must not submit passwords or low-entropy values as refresh tokens.
