# Agent Note: Provider-owned user credentials

Status: implemented

English | [中文](2026-08-23-provider-owned-user-credentials.zh.md)

## Problem

Human users need mutable login identifiers and password verification without adding password hashes, lookup indexes, or authentication policy to the stable user directory. Identifier normalization differs by kind and deployment, while a password verifier must never cross the component that owns its hashing and storage. Login responses also must not reveal whether an account exists or has password login enabled.

The [user-directory decision](../../proposed/architecture/2026-08-23-dsh-user-directory-service.md) deliberately leaves these records to a separate owner. That separation needs one provider-neutral API so authentication and administration Consumers do not depend on MySQL schemas or one hashing implementation.

## Decision

`@deepseek-ai/dsh-user-credential` defines the Host-only `ctx.userCredentials` service. It maps extensible login identifier kinds to the `UserId` owned by `dsh-user`, and it owns password set, change, verification, and disable operations. It depends on `dsh-user` only for types and opens no storage or network resource.

One mounted Provider owns supported identifier kinds, kind-specific normalization, global uniqueness of normalized `(kind, value)` pairs, password hashing and parameters, verifier and dummy-hash storage, transactions, and durable metadata. Passwords enter protected Provider operations; hashes, salts, peppers, and verifier versions have no public representation and never appear in service results or events.

## Aggregate concurrency

One user has one credential aggregate containing identifier metadata and password-enabled state. The aggregate does not exist at revision zero; its first identifier or password mutation commits revision 1. Identifier and password mutations share the same monotonic revision and atomically return the exact metadata before and after the commit.

The shared revision intentionally serializes simultaneous password resets and identifier administration. The base service validates Provider commit proofs and rejects unrelated metadata changes as `provider-unavailable`, so a faulty Provider cannot publish a partial or mislabeled mutation.

## Enumeration resistance

Identifier `resolve()` returns `UserId | undefined` only to trusted authentication and administration Consumers. A transport does not expose it as an account-discovery endpoint. Login composition resolves an identifier and verifies credentials behind one generic public failure, rate limit, and audit policy.

`verifyPassword()` returns only a boolean. Unknown users, users without an enabled password, and incorrect passwords all return `false`. The Provider performs comparable password-verifier work, using private dummy verifier material where necessary, before returning those results. Operational Provider failures remain `provider-unavailable`; a false credential result never carries a narrower reason.

## Metadata and events

Trusted metadata reads return normalized identifier kind and value, creation times, aggregate revision, update time, and password-enabled/change-time state. They never return password material. Results are bounded, detached, and immutable.

Every committed mutation emits `user-credential/changed` after commit with only the change category, `UserId`, revision, Provider time, and optional actor, reason, and correlation metadata. Identifier kinds and values, passwords, verifier metadata, and Provider diagnostics are excluded. Durable external delivery remains a persistence Provider's transactional-outbox responsibility.

## Provider verification

The package exports no concrete Provider, but its package-level contract suite is reusable by every Provider. The suite covers normalization and global uniqueness, identifier lifecycle, password set/change/verify/disable, false-result enumeration resistance, optimistic concurrency, post-commit timing, event redaction, and detached metadata. Provider-specific suites additionally prove real hash verification, dummy verification behavior, uniqueness indexes, transactions, durability, and migration behavior.

## Alternatives considered

**Store identifiers and password hashes in `dsh-user`.** Rejected because profile lifecycle, indexed login lookup, verifier rotation, and secret storage have different security rules and Provider evolution. Keeping them together would make every user-directory Provider implement authentication storage.

**Put one normalizer registry in the Service Definition.** Rejected because supported kinds and canonicalization rules must agree atomically with the Provider's uniqueness index. A separately mounted normalizer can drift from stored lookup semantics.

**Use separate revisions for each identifier and password.** Rejected because an administration screen commonly replaces several login methods from one snapshot. One aggregate revision detects every intervening credential change and prevents stale whole-form writes from undoing a password reset or identifier recovery.

**Return detailed password failures.** Rejected because distinguishing absent account, password-disabled, and wrong password creates an enumeration channel. Detailed recovery and administration state comes from authorized metadata operations, not the login verifier.

**Let the Service Definition hash passwords.** Rejected because algorithm choice, pepper access, native-library lifecycle, rehash policy, and dummy verification belong with durable verifier storage. Moving hashes through the service API would widen secret-bearing interfaces and logs.

## Consequences

Authentication and administration Consumers use one API across storage and hashing implementations, and no password verifier can escape through its types. Optimistic concurrency and sanitized events provide deterministic integration points without pulling credentials into user profiles or Session replay.

The active Provider is security-critical and must implement normalization, atomic uniqueness, password hashing, constant-work dummy verification, and durable transactions correctly. The Service Definition can validate metadata proofs but cannot measure timing equality or prove hash strength; every production Provider must supply those tests and deployment guidance. A shared revision also creates intentional conflicts between unrelated credential edits, requiring callers to reread and retry rather than merge implicitly.
