# Agent Note: MySQL refresh-token family Provider

Status: implemented

English | [中文](2026-08-24-dsh-auth-token-mysql-provider.zh.md)

## Problem

The provider-neutral [`dsh-auth-token` lifecycle](../../proposed/architecture/2026-08-23-dsh-auth-token-family-service.md) needs durable multi-process storage that preserves exactly-once refresh rotation and family-wide reuse revocation. A database Provider must not persist bearer secrets, return state for a different inspection target, or introduce conflicting lock orders between rotation and revocation.

## Decision

`@deepseek-ai/dsh-auth-token-mysql` implements `AuthTokenService` over the Host-only `ctx.mysql` connection service. It owns a version table, one token-family table, one refresh-credential table, their indexes and foreign key, all SQL, row decoding, transaction policy, and storage-error mapping. It does not modify `dsh-auth-token` or add token behavior to `dsh-mysql`.

Schema version 1 stores the principal kind and id, family lifecycle state, absolute expiry, monotonic revision, and optional revocation metadata. Each credential row stores its id, family id, unique SHA-256 digest, lifecycle state, expiry, and rotation or revocation metadata. SHA-256 is appropriate only because `dsh-auth-token` generates at least 256 bits of random refresh-secret entropy; the schema never accepts passwords through this API.

Family creation inserts the family and initial credential in one transaction. Rotation first reads the digest to discover its immutable family id, locks that family, then locks the credential and verifies the relation again. Every revocation path locks families in deterministic id order before locking or updating their credentials. This single family-first order prevents rotation and revocation from creating an application-level lock cycle.

Two rotations of the same active digest serialize on the family lock. The first transaction marks the submitted credential as rotated, inserts its replacement with the locked family's absolute expiry, and advances the family revision. The second transaction observes the rotated credential, revokes the family and all active credentials, advances the revision again, commits, and returns the reuse result required by `dsh-auth-token`. Expiry and already-revoked family checks occur under the same locks without mutation.

Inspection opens a transaction, acquires shared locks for only the families selected by the credential, family, or exact principal target, then loads credentials for those family ids. The locks keep both reads in one consistent snapshot relative to rotation and revocation. Credential revocation rereads and locks the named credential after locking its family and returns that record as `matchedCredential`, allowing `dsh-auth-token` to prove the target relation before emitting an event. Row decoding rejects unknown principal kinds, lifecycle states, revocation reasons, malformed ids or digests, impossible timestamp relations, and fields inconsistent with their status. Driver diagnostics, SQL, digests, and bearer secrets never enter Provider errors.

Schema activation acquires a MySQL advisory lock whose name includes a digest of the selected database, rereads all schema state inside that lock, and releases it in `finally`. It rejects unavailable lock ownership, an incompatible version, any unversioned owned table, and a version record with either owned table missing. A release failure fails activation, and a simultaneous initialization and release failure retains both causes internally. MySQL DDL commits independently, so a failure between table creation and version insertion can leave unversioned state; the next activation fails closed instead of guessing ownership or completing a partially observed schema.

## Alternatives considered

**Store bearer refresh tokens.** Rejected because a database disclosure would immediately yield active credentials. A unique digest supports exact lookup and replay detection without retaining the bearer value.

**Use optimistic updates without row locks.** Rejected because a failed compare-and-set identifies contention but does not by itself distinguish legitimate rotation from reuse or atomically revoke every active credential in the family.

**Lock the credential before its family.** Rejected because principal and family revocation naturally begin with one or more families. Opposite ordering would create a repeatable deadlock cycle between rotation and revocation.

**Delete consumed credentials.** Rejected because a consumed digest must remain recognizable as reuse so the Provider can revoke the complete family.

**Share the user-directory schema metadata table.** Rejected because the token Provider must own and version its persistent format independently of user profiles and login credentials.

## Consequences

The Provider gives multiple Host processes one durable serialization point for refresh rotation and revocation while keeping bearer secrets ephemeral. Reuse detection retains consumed digests until a future retention policy removes the family. Principal revocation locks every selected family in id order and can hold more rows than a single-family operation. Schema version mismatch and partial unversioned DDL fail startup because no released persistence compatibility exists.

Keyless tests run the shared Provider suite against a stateful MySQL test service and pin serialized schema initialization, exact target binding, shared-lock inspection snapshots, rollback behavior, error redaction, hostile durable-row validation, concurrent rotation, reuse, and idempotent revocation. The `DSH_MYSQL_TEST_URL`-gated test creates the real schema, verifies digest-only storage, races two rotations, observes family revocation, and exercises principal revocation.
