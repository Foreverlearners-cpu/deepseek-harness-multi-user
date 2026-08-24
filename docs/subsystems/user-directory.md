# User Directory

English | [中文](user-directory.zh.md)

The user-directory subsystem is [`@deepseek-ai/dsh-user`](../../packages/identity/user/README.md), a Host-only Service Definition for stable human user records and authoritative account lifecycle state. A concrete Provider supplies `ctx.users`; authentication, authorization, tenancy, credentials, and storage remain independent owners.

[`@deepseek-ai/dsh-user-mysql`](../../packages/identity/user-mysql/README.md) is the durable MySQL Provider. It owns the directory tables, schema version, row transactions, and keyset cursor encoding while using the separate `ctx.mysql` connection service.

## Record and lifecycle

`UserRecord` identifies one human account with a Provider-generated `UserId`. It carries an optional display name, `active`/`disabled`/`deleted` status, Provider timestamps, a monotonic revision, and bounded non-authoritative extensions. Deletion is terminal, and an id is never reassigned.

## Optimistic mutation

Profile and status mutations include `expectedRevision`. The Provider compares and writes atomically, increments revision by one, and returns the exact before and after records. The Service Definition validates that commit before publishing it to the caller or event listeners.

## Provider responsibilities

One Provider implements creation, exact-id reads, atomic mutation, and bounded cursor pages. The base service validates and detaches results, normalizes unexpected failures, and emits sanitized events only after a commit. A MySQL Provider owns schema and transactions; it does not move credentials into the directory record.

## Authorization and audit

Business services authenticate the actor and enforce self-service or administrative permission before invoking `ctx.users`. Optional actor, reason, and correlation metadata is audit context, not authorization proof. `user/changed` excludes profile and credential data and supports process-local audit, cache, and projection consumers.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxusers--userdirectory-abstract-seam"></a>

### `ctx.users` — `UserDirectory` (abstract seam)

Abstract user directory. Providers own durable records and atomic revision checks; this base owns validation, stable failures, detached results, and post-commit events.

```ts cordis-catalog
/** Create one active user with a Provider-generated stable id.
 * @param input - optional profile and trusted operation metadata.
 * @returns immutable committed user record.
 */
async create(input: UserCreateInput = {}): Promise<UserRecord>

/** Get one current user record.
 * @param id - stable user identity.
 * @returns immutable record, or undefined when absent.
 */
async get(id: UserId): Promise<UserRecord | undefined>

/** Require that one user exists and is currently active.
 * @param id - stable user identity.
 * @returns immutable active user record.
 */
async requireActive(id: UserId): Promise<UserRecord>

/** Update mutable profile fields using optimistic concurrency.
 * @param request - target id, expected revision, patch, and operation metadata.
 * @returns immutable committed user record.
 */
async update(request: UserUpdateRequest): Promise<UserRecord>

/** Disable one active user using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable disabled user record.
 */
disable(request: UserStatusRequest): Promise<UserRecord>

/** Enable one disabled user using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable active user record.
 */
enable(request: UserStatusRequest): Promise<UserRecord>

/** Soft-delete one active or disabled user using optimistic concurrency.
 * @param request - target id, expected revision, and operation metadata.
 * @returns immutable terminal user record.
 */
delete(request: UserStatusRequest): Promise<UserRecord>

/** List one bounded page of current users.
 * @param query - optional status, limit, and opaque cursor.
 * @returns immutable page and optional continuation cursor.
 */
async list(query: UserListQuery = {}): Promise<UserPage>
```

Source: [`packages/identity/user/src/index.ts:288`](../../packages/identity/user/src/index.ts)

<a id="user-events"></a>

### `user/*` events

<a id="userchanged--emit"></a>

#### `user/changed` — emit

Committed user-directory change without profile or credential data.

```ts cordis-catalog
/**
 * Committed user-directory change without profile or credential data.
 * @param event - sanitized lifecycle fact safe for trusted audit listeners.
 * @mode emit
 */
'user/changed'(event: UserChangeEvent): void
```

Source: [`packages/identity/user/src/types.ts:145`](../../packages/identity/user/src/types.ts)
<!-- END GENERATED cordis-surface -->
