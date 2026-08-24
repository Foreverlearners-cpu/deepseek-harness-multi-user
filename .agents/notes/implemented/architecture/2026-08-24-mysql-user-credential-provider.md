# Agent Note: MySQL user credential Provider

Status: implemented

English | [中文](2026-08-24-mysql-user-credential-provider.zh.md)

## Problem

The provider-neutral user credential service needs durable multi-process identifier uniqueness, optimistic aggregate revision, password verifier storage, and comparable work for negative password verification. Putting these choices in the Service Definition would couple every deployment to MySQL and one password format, while delegating them without a concrete Provider leaves authentication unable to store login state safely.

## Decision

`@deepseek-ai/dsh-user-credential-mysql` subclasses `UserCredentialService` over the Host-only `ctx.mysql` connection service. It owns separate versioned metadata, aggregate, and normalized-identifier tables. The identifier table has a binary `utf8mb4` unique index over `(kind, normalized_value)`; normalization trims, applies NFKC, and uses locale-independent English lowercase before storage or lookup.

Password verifier version 1 uses Node.js scrypt with fixed persisted parameters, a fresh random salt, and timing-safe derived-key comparison. The Provider validates every persisted field against that version before using it. A process-local random-salt dummy verifier runs for an unresolved identifier, absent aggregate, or disabled password. Secrets and verifier fields never cross the Provider API, event, or diagnostic interface.

Identifiers and password state share one aggregate revision. Mutations lock the aggregate row, compare expected revision, apply child-row or verifier changes, update through the same revision predicate, reread metadata, and commit. Duplicate-key races map to identifier or revision conflicts according to the attempted insert. Every other storage, crypto, malformed-row, and transaction failure is rebuilt by the Service Definition as a cause-free `provider-unavailable` error.

## Alternatives considered

**Store password hashes in `dsh-user-mysql`.** Rejected because profile lifecycle and login credentials have separate Consumers, retention rules, mutation revisions, and Provider choices.

**Use a password-hashing npm dependency.** Rejected for version 1 because Node scrypt is available across the supported runtime without native addon distribution or another supply-chain dependency. A future Argon2 Provider or verifier version remains possible.

**Make scrypt parameters configurable.** Rejected because verifier parameters are persisted security data, not deployment-only settings. Silent configuration changes would make existing rows unverifiable or permit unsafe weakening; format changes require a new version and migration decision.

**Use one permanent dummy verifier stored in MySQL.** Rejected because it adds shared secret-like database state and synchronization without improving the required equivalent derivation work. Startup generates one random-salt process-local verifier with the same version parameters.

**Depend on a case-insensitive MySQL collation for identifier normalization.** Rejected because database collation behavior is not the Provider's explicit canonical value and can change across collations or server upgrades. The Provider stores its canonical Unicode value under binary comparison.

## Consequences

MySQL deployments gain durable credential state, atomic revision checks, and globally unique normalized identifiers without changing the Service Definition. Schema and verifier version mismatches fail rather than guessing compatibility. Scrypt work constrains offline guessing, while endpoint-level rate limiting and generic authentication responses remain required. Database presence and scheduling can still produce timing differences, so equivalent derivation work is not a claim of indistinguishable network latency.

The implementation is pinned by the public framework-neutral Provider suite, storage-specific transaction and malformed-row tests, 100% per-file coverage, and a `DSH_MYSQL_TEST_URL`-gated real MySQL suite for Unicode persistence, unique-identifier races, and revision CAS races.
