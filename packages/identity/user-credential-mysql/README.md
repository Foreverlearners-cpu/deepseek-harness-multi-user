# @deepseek-ai/dsh-user-credential-mysql

English | [中文](README.zh.md)

MySQL Service Provider for [`dsh-user-credential`](../user-credential). It supplies `ctx.userCredentials` through the shared [`dsh-mysql`](../../multi/mysql) connection service and owns identifier normalization, global identifier uniqueness, password verifier derivation and storage, credential transactions, and its schema.

## Composition

Mount one `dsh-mysql` service before this plugin and mount exactly one `ctx.userCredentials` Provider. Activation creates or verifies `dsh_user_credential_schema`, `dsh_user_credentials`, and `dsh_user_login_identifiers`. An existing incompatible version, an incomplete versioned schema, or an unversioned same-name data table rejects activation.

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: user-credentials
  package: '@deepseek-ai/dsh-user-credential-mysql'
```

Consumers use the provider-neutral `ctx.userCredentials` API. Identifier values are trimmed, Unicode NFKC-normalized, and lowercased with locale-independent English casing before uniqueness or lookup. The normalized `(kind, value)` pair is globally unique; the identifier table uses `utf8mb4_bin` so MySQL does not apply a second implicit case or accent normalization.

## Password Verifiers

Password version 1 uses Node.js `crypto.scrypt` with `N=16384`, `r=8`, `p=1`, a random 16-byte salt, and a 32-byte derived key. These values and the verifier version are persisted-format security constants, not deployment tuning. Changing them requires a new verifier version and an explicit upgrade strategy.

Raw passwords exist only as operation parameters and scrypt inputs. The schema stores version, bounded parameters, salt, derived key, and change time; metadata, events, return values, and Provider diagnostics never contain those fields. Verification uses `timingSafeEqual` after derivation. Startup creates a process-local random-salt dummy verifier, and missing identifiers, missing users, and disabled passwords execute the same supported scrypt parameters before returning `false`.

## Transactions and Failures

Identifiers and password state share one aggregate row and revision. Each mutation locks the aggregate with `SELECT ... FOR UPDATE`, validates the expected revision, applies identifier or verifier state, updates with the same revision predicate, rereads metadata, and commits. The unique `(kind, normalized_value)` index serializes identifier assignment across users and processes. The base service emits its sanitized event only after this Provider returns the committed result.

Expected duplicate identifiers, missing state, invalid current passwords, and revision conflicts retain their stable `dsh-user-credential` error codes. SQL, schema, malformed verifier, transaction, cryptographic, and rollback failures are rebuilt by the base service as `provider-unavailable` without Provider messages or causes.

## Model Experience

### MySQL user credentials

#### What the model sees

Nothing. The Provider is Host-only and supplies `ctx.userCredentials` without registering a tool, prompt, message, or Session event. It only backs the existing process-local sanitized credential event.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: credential reads and mutations do not alter a request prefix.

## Known Limitations and Deferred Work

- **Schema and verifier version 1 only** - incompatible database versions fail activation, and existing verifier rows are not opportunistically rehashed.
- **No password policy or recovery** - password strength, breached-password checks, reset challenges, email verification, MFA, lockout, and rate limiting belong to dedicated Consumers or Providers.
- **No pepper or external KMS** - version 1 relies on per-password salts and database access controls; a deployment requiring a pepper needs a separately designed key lifecycle and verifier version.
- **Comparable work, not a network timing proof** - false verification paths run one scrypt with the same parameters, but database access and scheduling can still differ; authentication endpoints also require generic responses and rate limits.
- **No automatic account lifecycle reaction** - disabling or deleting a `dsh-user` record does not delete credential rows; authentication composition must require an active user.
- **No transactional outbox** - the sanitized change event is process-local and follows commit; durable audit delivery requires an outbox owned by a later persistence design.
