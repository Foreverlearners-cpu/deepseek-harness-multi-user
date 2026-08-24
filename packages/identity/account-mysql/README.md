# @deepseek-ai/dsh-account-mysql

English | [中文](README.zh.md)

MySQL Service Provider for the durable registration-operation interface owned by [`dsh-account`](../account). It uses the shared [`dsh-mysql`](../../multi/mysql) connection service and stores only non-secret registration progress, recovery state, and the completed `UserRecord`. It never stores login identifiers, passwords, password verifiers, access tokens, refresh tokens, or token digests.

## Composition

Mount `dsh-mysql` and `dsh-account` before this plugin. Activation acquires a database-scoped advisory lock, creates or verifies `dsh_account_schema` and `dsh_account_registration_operations`, releases the lock, then registers the sole `ctx.accounts.registrationOperations` Provider. An unavailable lock, unversioned owned table, missing versioned table, or version other than `ACCOUNT_MYSQL_SCHEMA_VERSION` rejects activation.

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: account
  package: '@deepseek-ai/dsh-account'
- name: accountOperations
  package: '@deepseek-ai/dsh-account-mysql'
```

Account Consumers continue to call `ctx.accounts.register(...)`; they do not import this package. Mount exactly one registration-operation Provider. This package has no configuration because the table name, indexes, schema identity, and persisted fields are durable-format constants.

## Idempotency and concurrency

`requestId` is the unique registration idempotency key. `begin(requestId)` atomically creates revision `1` at `begun` or returns the existing operation. A caller must create a new `requestId` for every logically new registration and may reuse a key only to retry the same registration. The Provider intentionally does not persist or compare the password, identifier, profile input, or an input fingerprint. Once an operation is `completed`, every retry returns its immutable stored `UserRecord`, even when an untrusted transport submits different retry fields; the transport must prevent accidental key reuse.

Every stage transition locks the row and compares both revision and stage. The only forward path is `begun` to `user-created` to `identifier-added` to `password-set` to `completed`; any non-terminal stage may become `failed` with a complete non-secret recovery record. A stale revision, changed stage, changed user relation, invalid transition, or second completion returns `conflict` without modifying the row. Completion writes all `UserRecord` fields in the same transaction and never updates a completed result.

Durable rows are rejected unless all ids, enums, positive revisions, boolean flags, nullable groups, timestamp ordering, user relations, and namespaced JSON extensions form one valid `RegistrationOperationRecord`. Connection, SQL, malformed-row, schema, and rollback failures become `unavailable` without retaining driver diagnostics. This Provider does not make user-directory and credential writes part of one MySQL transaction; `dsh-account` owns the staged saga and compensation behavior.

## Model Experience

### MySQL registration progress

#### What the model sees

Nothing. The Provider is Host-only and registers no tool, prompt, message, or Session event. Account events remain the sanitized process-local events emitted by `dsh-account` after orchestration commits.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Database operations do not alter a model-request prefix.

## Known Limitations and Deferred Work

- **Schema version 1 only** - incompatible or unversioned owned tables fail activation; no migration is attempted.
- **Caller-owned request ids** - this Provider cannot detect a logically different registration that reuses a completed request id because the provider-neutral interface supplies only the id.
- **No transactional outbox** - account events remain process-local and follow commits; durable audit delivery needs a separately owned outbox.
- **Single database binding** - the Provider uses the one injected `ctx.mysql` service and does not select a database per request or tenant.
