# Agent Note: MySQL registration operation Provider

Status: implemented

English | [中文](2026-08-24-mysql-registration-operation-provider.zh.md)

## Problem

Account registration crosses the user directory and credential services, so a process crash can otherwise lose which effects committed and a transport retry can create a second account. The provider-neutral account package needs durable idempotency without making one database Provider own user, credential, or token data.

## Decision

`@deepseek-ai/dsh-account-mysql` implements only `RegistrationOperationProvider` and stores one operation per unique `requestId`. The row contains the monotonic revision, closed registration stage, stable user relation, optional non-secret recovery state, and an immutable completed `UserRecord`. It contains no identifier, password, verifier, token, token digest, or duplicate authoritative profile outside the completed result required by the interface.

`begin` uses one transaction to insert or lock the existing request row. `advance` locks the row, compares revision and stage, checks the forward transition and stable user relation, then writes the next revision. `complete` accepts only `password-set`, stores the result once, and makes it terminal. Database rows are strictly decoded before use, and storage diagnostics are replaced with fixed account error categories.

Schema initialization serializes with a database-scoped advisory lock. A schema version record and the owned table must either both exist at version `1` or both be absent; the Provider rejects incompatible, incomplete, and unversioned states instead of guessing their provenance.

The provider-neutral method receives only `requestId`, so idempotency identifies a logical registration by that key rather than by a fingerprint of secret or profile input. Callers allocate a fresh key for new work. A completed retry returns the first stored result regardless of later request fields, which avoids retaining secret comparison material and preserves the existing `dsh-account` behavior.

## Alternatives considered

**Store registration inputs or a fingerprint.** The shared interface does not supply an input fingerprint, and deriving one from a password would introduce secret-derived durable state into an operation table. Changing the account interface would also contradict completed-retry behavior that ignores replacement retry fields.

**Store user and credential copies in this package.** Copies would create competing authorities and couple this Provider to the storage choices behind `dsh-user` and `dsh-user-credential`. The registration operation instead records only saga progress and the interface-required final result.

**Use one transaction across all account effects.** The account services may use different Providers or systems, so no shared transaction is available. Durable stages plus explicit compensation preserve provider independence and make partial progress recoverable.

## Consequences

Multiple Host processes can safely retry or race one registration key, and stale workers cannot advance or replace its result. Operators get explicit schema ownership and fail-fast compatibility checks. The cost is an additional table and transaction per stage, and transports remain responsible for never assigning the same `requestId` to different logical registrations. Events still occur after database commit without a transactional outbox.
