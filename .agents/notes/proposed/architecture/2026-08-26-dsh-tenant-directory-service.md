# Agent Note: dsh-tenant directory service

Status: proposed

English | [中文](2026-08-26-dsh-tenant-directory-service.zh.md)

## Problem

Authorization, team membership, administration tools, and audit Consumers need one stable identifier for a tenant and one authoritative source for whether a human user currently belongs to that tenant. Login identity, conversation-owned tenant fields, display names, and authenticated-call provenance each have different ownership and change rules, so none can substitute for that membership fact.

Putting tenant rows or membership onto `dsh-user` would couple account lifecycle to an independently changing many-to-many relation. Putting a tenant onto `AuthenticatedCall` would make identity carry authorization scope. Reusing `ConversationTenantId` would let one product store own the identifier every later team and authority plugin must share.

The repository needs a provider-neutral tenant directory before it adds a MySQL Provider, teams, or authorization. The service must define tenant identity, membership lifecycle, concurrency, failures, and Provider obligations without creating a database schema or deciding whether a caller may manage a tenant.

## Proposal

Add `@deepseek-ai/dsh-tenant` as the Service Definition for tenant records and user memberships. It owns the branded `TenantId` and `MembershipId`, immutable record fields, lifecycle operations, provider-neutral failures, bounded live events, and a shared Provider conformance suite. A deployment mounts exactly one Service Provider to supply `ctx.tenants`.

`dsh-tenant` has no production fallback and does not depend on MySQL, Redis, HTTP, Session, team, authorization, or authentication implementation packages. It may depend on Cordis, the repository branded-id utility, invariants, and `dsh-user` only for the branded `UserId` and its validator. Merely mounting `dsh-tenant` does not create a tenant, authenticate a request, or change an existing product route.

The directory represents tenants and membership usability only. Roles hang on later team records. Object grants remain an ACL concern. Conversation persistence keeps its own `ConversationTenantId` until a later mapping Consumer joins the two identifiers.

## Tenant and membership records

The proposed public tenant record contains these fields:

| Field | Meaning |
| --- | --- |
| `tenantId` | Provider-generated branded identity that never changes or returns to another tenant. |
| `displayName` | Optional human-facing label; it is not a login identifier or authorization fact. |
| `status` | Closed lifecycle value: `active`, `disabled`, or `deleted`. |
| `createdAt` | Non-negative epoch-millisecond creation time chosen by the Provider. |
| `updatedAt` | Non-negative epoch-millisecond time of the latest committed mutation. |
| `revision` | Monotonic optimistic-concurrency value incremented by each committed mutation. |

The proposed public membership record contains these fields:

| Field | Meaning |
| --- | --- |
| `membershipId` | Provider-generated branded identity of one membership slot. |
| `tenantId` | Tenant that owns the slot. |
| `userId` | Branded human user imported from `dsh-user`; this package does not look up `ctx.users`. |
| `status` | Closed lifecycle value: `active`, `disabled`, or `removed`. |
| `createdAt` | Non-negative epoch-millisecond creation time chosen by the Provider. |
| `updatedAt` | Non-negative epoch-millisecond time of the latest committed mutation. |
| `revision` | Monotonic optimistic-concurrency value incremented by each committed mutation. |

One current slot exists per `(tenantId, userId)`. An active or disabled slot cannot be duplicated. `removed` is terminal for that `MembershipId`; adding the same pair again creates a new id. Roles, teams, ACLs, credentials, and extensions are not fields on either record.

## Directory operations

The Service Definition exposes tenant `create`, `get`, `requireActive`, `disable`, `enable`, and `delete`, plus membership `addMember`, `getMembership`, `requireActiveMembership`, `disableMembership`, `enableMembership`, `removeMembership`, `listMembers`, and `listUserMemberships`. Every Provider preserves these semantics:

- Create validates the optional display name, generates a new `TenantId`, starts at `active`, initializes revision, and returns the committed record.
- Get returns one tenant or an explicit absence without changing lifecycle state.
- Require-active returns the current tenant only for `active`; missing, disabled, and deleted tenants produce distinct internal failure codes.
- Disable accepts only `active`; enable accepts only `disabled`; soft-delete accepts `active` or `disabled` and is terminal.
- Add-member requires an active tenant, generates a new `MembershipId`, and fails with `membership-conflict` when an active or disabled slot already exists.
- Require-active-membership checks the tenant first and reports `tenant-disabled` or `tenant-deleted` before membership codes.
- List operations use a bounded limit and opaque cursor with optional status filtering. Listing members of a missing tenant fails; listing memberships of a user does not require `ctx.users`.
- Mutations may carry trusted `actorUserId`, reason, and correlation metadata for audit Consumers. This metadata does not prove authorization.

## Lifecycle and concurrency

Allowed tenant transitions are `active -> disabled`, `disabled -> active`, `active -> deleted`, and `disabled -> deleted`. Allowed membership transitions are `active -> disabled`, `disabled -> active`, `active -> removed`, and `disabled -> removed`. Terminal states do not transition again. Repeating a transition does not silently succeed.

Every mutation compares `expectedRevision` with the current record and commits the new data and incremented revision atomically. A stale revision produces `revision-conflict` and does not partially change status, timestamps, or events. The Provider chooses timestamps from its trusted clock; callers cannot write `createdAt`, `updatedAt`, or `revision`.

The package defines stable failures for invalid input, absence, inactive tenant or membership state, duplicate current membership, invalid transition, revision conflict, unavailable Provider, and unexpected Provider failure. Storage-specific error codes never cross the service API.

## Events and Consumers

After a mutation commits, the service emits `tenant/changed` or `tenant/membership-changed`. Events include the relevant ids, the committed revision, status, event time, and available caller-supplied actor, reason, and correlation metadata. They exclude display names, roles, credentials, transport evidence, and Provider diagnostics.

These events are process-local integration facts for audit, cache invalidation, and projections. They are not Session events, do not enter model-visible replay, and do not replace a durable transactional outbox owned by a persistence Provider.

Later `dsh-team`, `dsh-authority`, and `dsh-tenant-authority` Consumers use `TenantId` and membership usability but retain their own state and decisions. `dsh-auth` continues to mint identity only.

## Provider ownership

`dsh-tenant` owns no tables, migrations, files, caches, environment variables, or network clients. A later `dsh-tenant-mysql` Provider will own the physical tenant and membership tables, indexes, transactions, migration version, and MySQL error classification. Its schema proposal must implement this record and lifecycle contract without adding roles or team ownership to the directory.

A shared conformance suite runs against every Provider implementation. It covers id branding and uniqueness, lifecycle transitions, terminal deletion and removal, re-add after removal, optimistic concurrency, cursor stability, event timing and redaction, failure normalization, and Provider disposal.

## Alternatives considered

**Put tenant membership on `dsh-user`.** Rejected because a user may belong to several tenants and membership can change independently of account profile and lifecycle. The user-directory Agent Note already assigned those records to `dsh-tenant`.

**Put `tenantId` on `AuthenticatedCall`.** Rejected because authentication answers who the caller is, not which tenant they may use. Carrying tenant on the identity object would force every authenticated request to pick a tenant and would mix identity with authorization scope.

**Reuse `ConversationTenantId` as the Host tenant id.** Rejected because conversation persistence owns that brand and its storage. Team and authority plugins need a directory identity that is not a session-product foreign key.

**Store roles or team ids on the membership row.** Rejected because roles hang on teams and object grants are a separate ACL route. Expanding this table into user × team × role is the explosion the membership slot is designed to avoid.

**Treat missing membership as allow.** Rejected because the authorization design is default deny. A missing or inactive membership is a distinct refusal, not an implicit grant.

## Acceptance criteria

- The package defines branded `TenantId` and `MembershipId`, tenant and membership records, status lifecycles, provider-neutral operations, stable failure categories, bounded events, and a Provider conformance suite.
- The package imports no authentication implementation, authorization, team, Session, transport, database, or cache package and opens no external resource. It may import `dsh-user` only for `UserId`.
- Tenant and membership creation generate ids inside the mounted Provider; status mutations use mandatory optimistic concurrency; deleted tenant ids and removed membership ids are terminal.
- `requireActiveMembership` reports tenant inactivity before membership codes; re-adding a removed pair creates a new `MembershipId`.
- Provider events occur only after commit and exclude display names, roles, credentials, and diagnostics; they never enter the Session event log.
- Focused tests cover every lifecycle transition and refusal, stale concurrent mutation, cursor pagination, event redaction, listener containment, and Provider disposal.
- Existing Session, Agent, authentication, and shipped bundle behavior remains unchanged when only `dsh-tenant` is added.
- The MySQL schema, teams, roles, ACL grants, and product-route integration remain separate follow-up changes with their own owners.

## Risks

- A directory API designed around only the first MySQL Provider could leak SQL pagination, timestamp, or transaction assumptions. Opaque cursors, provider-owned clocks, and the shared conformance suite must keep the L1 behavior provider-neutral.
- Distinct internal inactive-state failures can support administration but may leak tenant or membership existence when mapped directly to a public response. Transport Consumers must collapse them where enumeration resistance requires it.
- Soft deletion and removal preserve references and auditability but do not satisfy a future physical-erasure policy by themselves. Erasure and retention need a separate cross-domain workflow.
- Separating the Service Definition from every Provider increases package and composition count. The separation is intentional so storage and later team or authority choices do not modify membership Consumers, but a later starter package must make valid compositions straightforward.
