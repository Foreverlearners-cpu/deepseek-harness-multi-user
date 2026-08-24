# 用户目录

[English](user-directory.md) | 中文

用户目录子系统是 [`@deepseek-ai/dsh-user`](../../packages/identity/user/README.md)，它是用于稳定人类用户记录和权威账号生命周期状态的 Host-only Service Definition。具体 Provider 提供 `ctx.users`；认证、授权、租户、Credential 和存储保持独立所有权。

[`@deepseek-ai/dsh-user-mysql`](../../packages/identity/user-mysql/README.md) 是持久 MySQL Provider。它拥有目录表、schema version、行事务和 keyset cursor 编码，并使用独立的 `ctx.mysql` 连接服务。

## 记录与生命周期

`UserRecord` 使用 Provider 生成的 `UserId` 标识一个人类账号。它包含可选显示名、`active`/`disabled`/`deleted` 状态、Provider 时间戳、单调 revision 和有界的非权威 extensions。删除是终态，id 永远不会重新分配。

## 乐观修改

资料与状态修改包含 `expectedRevision`。Provider 原子比较并写入、将 revision 增加 1，并返回准确的修改前后记录。Service Definition 在向调用者或事件监听器发布前验证该提交。

## Provider 职责

一个 Provider 实现创建、按 id 精确读取、原子修改和有界 cursor 分页。基础服务校验并分离结果、归一化意外失败，而且只在提交后发出脱敏事件。MySQL Provider 拥有 schema 和事务；它不会把 Credential 移入目录记录。

## 授权与审计

业务服务在调用 `ctx.users` 前认证操作者，并执行用户自助或管理员权限检查。可选的操作者、原因和关联元数据是审计上下文，不是授权证明。`user/changed` 排除资料和 Credential 数据，供进程内审计、缓存和投影消费方使用。

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
