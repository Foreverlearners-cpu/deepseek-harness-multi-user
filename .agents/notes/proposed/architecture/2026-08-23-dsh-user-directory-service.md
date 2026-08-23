# Agent Note: dsh-user directory service

Status: proposed

English | [中文](2026-08-23-dsh-user-directory-service.zh.md)

## Problem

Authentication Providers, tenant membership services, session owners, administration tools, and audit Consumers need one stable identifier for a human account and one authoritative source for its lifecycle state. An email address, username, display name, external identity, anonymous telemetry id, credential, and session id each have different ownership and change rules, so none can substitute for that identifier.

Putting user rows, password hashes, token sessions, MySQL queries, or a process-global current user into one package would couple account lifecycle to a credential mechanism, storage backend, and request carrier. Adding `userId` to existing Session, Agent, or RPC payload types would also make unrelated packages depend on account identity and could let a caller submit the fact used to scope its own data.

The repository needs a provider-neutral user directory service before it adds a MySQL Provider or concrete login mechanism. The service must define account identity, lifecycle, extension data, concurrency, failures, and Provider obligations without creating a database schema or claiming that a user has authenticated or is authorized.

## Proposal

Add `@deepseek-ai/dsh-user` as the Service Definition for human user records. It owns the branded `UserId`, immutable record fields, lifecycle operations, provider-neutral failures, bounded live events, and a shared Provider conformance suite. A deployment mounts exactly one Service Provider, such as the later `dsh-user-mysql`, to supply `ctx.users`.

`dsh-user` has no production fallback and does not depend on MySQL, Redis, JWT, HTTP, Session, tenant, authorization, or password packages. It may depend on Cordis, the repository branded-id utility, and a provider-neutral JSON value utility. Merely mounting `dsh-user` does not create a user, authenticate a request, or change an existing product route.

The directory represents human accounts only. Service accounts remain a separate principal kind because their ownership, credentials, approval behavior, and lifecycle differ. The stable internal `UserId` agrees with the identity model in [the multi-user reference](../../../../docs/multi-user/identity-and-access.md): changing login identifiers or profile data never changes the id.

## User record

The proposed public record contains these fields:

| Field | Meaning |
| --- | --- |
| `userId` | Provider-generated branded identity that never changes or returns to another account. |
| `displayName` | Optional human-facing profile label; it is not a login identifier or authorization fact. |
| `status` | Closed lifecycle value: `active`, `disabled`, or `deleted`. |
| `createdAt` | Non-negative epoch-millisecond creation time chosen by the Provider. |
| `updatedAt` | Non-negative epoch-millisecond time of the latest committed mutation. |
| `revision` | Monotonic optimistic-concurrency value incremented by each committed mutation. |
| `extensions` | Bounded JSON object for namespaced, non-sensitive, non-authoritative additions. |

The Provider generates `UserId`; create requests cannot select it. The id uses the repository branded-id rules and must not overlap with `AnonymousUserId`, an email address, a username, or an upstream OIDC subject. Imported accounts require a separate trusted import Consumer rather than a public create option that accepts an arbitrary id.

`displayName` may be absent and may change. Usernames, email addresses, phone numbers, OIDC issuer-subject pairs, password verifiers, API keys, roles, tenant memberships, preferences, and credentials are not user-record fields. Their owning capability can map them to `UserId` without changing the directory record.

## Directory operations

The Service Definition exposes `create`, `get`, `requireActive`, `update`, `disable`, `enable`, `delete`, and `list`. Every Provider preserves these semantics:

- Create validates profile input, generates a new `UserId`, starts at `active`, initializes revision, and returns the committed record.
- Get returns one record or an explicit absence without changing lifecycle state.
- Require-active returns the current record only for `active`; missing, disabled, and deleted records produce distinct internal failure codes.
- Profile update changes only `displayName` and `extensions`, requires the expected revision, and returns the new committed revision.
- Disable accepts only `active`; enable accepts only `disabled`; both require the expected revision.
- Soft-delete accepts `active` or `disabled`, produces terminal `deleted`, and never removes or reassigns the `UserId`.
- List uses a bounded limit and opaque cursor with optional status filtering; it never exposes credentials or Provider diagnostics.
- Mutations may carry trusted `actorUserId`, reason, and correlation metadata for audit Consumers. This metadata does not prove authorization; the calling business service checks self-service field policy or administrative RBAC before invoking the directory.

Transport Consumers decide which internal failures collapse to the same public response so account discovery is not exposed. `dsh-user` does not define HTTP status codes, RPC errors, or administration permission.

## Lifecycle and concurrency

Allowed status transitions are `active -> disabled`, `disabled -> active`, `active -> deleted`, and `disabled -> deleted`. `deleted` is terminal. Repeating a transition does not silently succeed: the Provider reports a stable state-conflict failure so callers must deliberately implement idempotency at their own request boundary.

Every mutation compares `expectedRevision` with the current record and commits the new data and incremented revision atomically. A stale revision produces `revision-conflict` and does not partially change profile, status, timestamps, extensions, or events. The Provider chooses timestamps from its trusted clock; callers cannot write `createdAt`, `updatedAt`, or `revision`.

The package defines stable failures for invalid input, absence, inactive state, invalid transition, revision conflict, unavailable Provider, and unexpected Provider failure. Storage-specific error codes, SQL text, connection details, and record existence diagnostics never cross the service API.

## Extensions contract

`extensions` is a JSON object, not a JSON-encoded string. The empty value is `{}`. Arrays, scalars, non-JSON values, cyclic objects, prototype-bearing objects, and values beyond the exported byte limit are rejected before persistence. The fixed L1 limit keeps Provider behavior interchangeable; a later proposal must change the shared contract before one Provider accepts larger records.

Keys use a package or organization namespace such as `dsh-user/locale` or `example/register-source`. Providers preserve unknown keys exactly across reads and unrelated updates. An update replaces or patches extensions only through an explicit operation; reading and rewriting a record must not discard additions owned by another Consumer.

Extensions never contain credentials, password material, tokens, signing keys, roles, tenant membership, suspension state, login identifiers, authorization decisions, or fields used for uniqueness and indexed lookup. A value that becomes security-relevant, constrained, frequently queried, or independently owned moves to a typed field or another service instead of remaining in extensions.

## Events and Consumers

After a mutation commits, the service emits bounded live events equivalent to user created, profile updated, and status changed. Events include `userId`, the committed revision, status, event time, and available caller-supplied actor, reason, and correlation metadata. They exclude `displayName`, `extensions`, login identifiers, credentials, transport evidence, and Provider diagnostics.

These events are process-local integration facts for audit, cache invalidation, and projections. They are not Session events, do not enter model-visible replay, and do not replace a durable transactional outbox owned by a persistence Provider. A Provider that cannot atomically publish an external event records its outbox in its own transaction and lets a separate Consumer deliver it.

`dsh-auth` consumes the directory only after credential verification identifies a `UserId`; it requires `active` before issuing or accepting account-backed credentials. The authenticated call remains owned by `dsh-auth` and is passed explicitly as described by the multi-user architecture; `dsh-user` does not expose a global current user. Tenant membership, authorization, session ownership, and security audit Consumers use `UserId` but retain their own state and decisions.

## Provider ownership

`dsh-user` owns no tables, migrations, files, caches, environment variables, or network clients. The later `dsh-user-mysql` Provider will own the physical `dsh_users` and schema-state tables, indexes, transactions, migration version, and MySQL error classification. Its schema proposal must implement this record and lifecycle contract without adding credential ownership to the directory.

Password or local-login Providers own login-identifier and password-verifier tables. JWT Providers own refresh-token families and authentication sessions. Audit Providers own append-only security records. The existing conversation persistence owner keeps session-to-user relations. This ownership prevents `dsh-user-mysql` from becoming a general authentication database.

A shared conformance suite runs against every Provider implementation. It covers id branding and uniqueness, lifecycle transitions, terminal deletion, optimistic concurrency, extension validation and preservation, cursor stability, event timing and redaction, failure normalization, and Provider disposal. Provider-specific tests additionally cover its durability and schema behavior.

## Alternatives considered

**Let `dsh-auth` own user CRUD.** Rejected because authenticated-call provenance and credential lifecycle change independently from account profile and lifecycle. Keeping the directory separate also permits administrative, import, tenant, and audit Consumers to use users without parsing authentication evidence.

**Put usernames, password hashes, and refresh tokens in the user record.** Rejected because login identifiers can be multiple and mutable, while credentials have security-specific rotation, redaction, compromise, and storage rules. Their schemas and Providers must evolve without changing the user directory.

**Define `UserId` as an alias of `string`.** Rejected because anonymous correlation ids, service accounts, tenants, sessions, and upstream subjects are also strings. A branded id prevents accidental substitution at typed same-process boundaries.

**Store extensions as a JSON string.** Rejected because each Provider would need a second parsing layer and could persist invalid JSON. The service accepts a JSON object and storage Providers use their native structured representation where available.

**Add `userId` to Session, Agent, and RPC payload types.** Rejected because unrelated core packages would acquire an identity dependency and a wire caller could submit an ownership claim. Resource Consumers receive authenticated context explicitly and verify stored ownership themselves.

**Expose an asynchronous-local or process-global current user.** Rejected because concurrent requests, background work, nested calls, and Provider callbacks can observe the wrong identity. The directory accepts explicit ids; authentication context remains owned by the transport and authentication composition.

**Include tenant membership and roles in `dsh-user`.** Rejected because a user may belong to several tenants and membership can change independently of account state. `dsh-tenant` and `dsh-authority` own those records and decisions.

## Acceptance criteria

- The package defines branded `UserId`, the user record, status lifecycle, extension JSON rules, provider-neutral operations, stable failure categories, bounded events, and a Provider conformance suite.
- The package imports no credential, authentication implementation, authorization, tenant, Session, transport, database, cache, or search package and opens no external resource.
- User creation generates an id inside the mounted Provider; profile and status mutations use mandatory optimistic concurrency; deleted ids are terminal and never reused.
- Extensions accept only bounded JSON objects, preserve unknown namespaced keys, and cannot carry secrets or authoritative identity, lifecycle, tenant, or permission fields.
- Provider events occur only after commit and exclude extensions, credentials, login identifiers, and diagnostics; they never enter the Session event log.
- Focused tests cover every lifecycle transition and refusal, stale concurrent mutation, extension validation and preservation, cursor pagination, event redaction, and Provider disposal.
- Existing Session, Agent, AgentLoop, API Proxy, RPC payload, persistence, and shipped bundle behavior remains unchanged when only `dsh-user` is added.
- The MySQL schema, login identifiers, password verification, JWT sessions, tenant membership, authorization, and product-route integration remain separate follow-up changes with their own owners.

## Risks

- A directory API designed around only the first MySQL Provider could leak SQL pagination, timestamp, or transaction assumptions. Opaque cursors, provider-owned clocks, and the shared conformance suite must keep the L1 behavior provider-neutral.
- Distinct internal inactive-state failures can support administration but may leak account existence when mapped directly to a public login response. Authentication and transport Consumers must collapse them where enumeration resistance requires it.
- Generic extensions can become an unreviewed schema if Consumers put queried or security-relevant data into them. The fixed limit, namespace rule, secret prohibition, and typed-field promotion rule require review enforcement.
- Soft deletion preserves references and auditability but does not satisfy a future physical-erasure policy by itself. Erasure and retention need a separate cross-domain workflow that coordinates credential, tenant, conversation, attachment, and audit owners.
- Separating the Service Definition from every Provider increases package and composition count. The separation is intentional so storage and credential choices do not modify account Consumers, but starter packages must make valid compositions straightforward.
