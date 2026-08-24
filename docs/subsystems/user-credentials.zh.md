# 用户 Credential

[English](user-credentials.md) | 中文

用户 Credential 子系统是 [`@deepseek-ai/dsh-user-credential`](../../packages/identity/user-credential/README.md)，它是把登录标识查询和密码验证映射到稳定 `UserId` 的 Host-only Service Definition。具体 Provider 提供 `ctx.userCredentials`；资料生命周期、authenticated-call 来源、授权、传输和存储保持独立所有权。

[`@deepseek-ai/dsh-user-credential-mysql`](../../packages/identity/user-credential-mysql/README.md) 是持久 MySQL Provider。它使用独立的 `ctx.mysql` 连接服务，并拥有 Credential 表和 schema version、归一化标识唯一性、带版本 scrypt verifier、dummy 验证和行事务。

## 标识语义

一个标识是可扩展的 `(kind, value)` 对。Provider 拥有 kind-specific 归一化和规范化 pair 的全局唯一性。添加、删除与解析会在执行约束的操作内部归一化。受信任的元数据读取会暴露规范化值，事件绝不暴露这些值。

## 密码语义

密码 Secret 只进入 Provider 方法，绝不出现在元数据或事件中。Provider 拥有 verifier 派生与存储，并为标识未解析、不存在的账号和已禁用密码执行可比的 dummy verifier 工作。公开验证允许省略 `userId`，把不存在、已禁用和错误 Credential 全部折叠为 `false`；Provider 错误会在不保留 Provider message 或 cause 的情况下重建。

## 并发与事件

标识和密码状态共享一个聚合 revision。每次修改比较 `expectedRevision`、原子提交、增加 1，并返回只含元数据的修改前后证明。服务在提交后发出 `user-credential/changed` 前校验证明。

## 组合

认证 Consumer 解析标识后始终调用密码验证；解析失败时不传 `userId`，以触发 dummy 工作。验证成功后再通过 `ctx.users` 要求用户处于 active 状态，最后才签发 authenticated call。管理员 Consumer 在修改前认证并授权操作者；operation context 提供审计元数据，但不证明权限。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxusercredentials--usercredentialservice-abstract-seam"></a>

### `ctx.userCredentials` — `UserCredentialService` (abstract seam)

Abstract credential service. Providers own normalization, uniqueness, verifier storage, dummy verification, and atomic revision checks.

```ts cordis-catalog
/** Normalize one raw login identifier.
 * @param input - extensible kind and raw value.
 * @returns immutable canonical identifier.
 */
async normalize(input: LoginIdentifierInput): Promise<LoginIdentifier>

/** Read detached non-secret metadata for one user.
 * @param userId - stable target user id.
 * @returns immutable metadata, or undefined when no aggregate exists.
 */
async get(userId: UserId): Promise<UserCredentialRecord | undefined>

/** Resolve a raw login identifier to its user, or undefined.
 * @param input - extensible kind and raw value.
 * @returns stable user id, or undefined when no identifier matches.
 */
async resolve(input: LoginIdentifierInput): Promise<UserId | undefined>

/** List login identifiers and password-state metadata for one user.
 * @param userId - stable target user id.
 * @returns immutable metadata, or undefined when no aggregate exists.
 */
list(userId: UserId): Promise<UserCredentialRecord | undefined>

/** Add one globally unique normalized login identifier.
 * @param request - target, revision, raw identifier, and audit context.
 * @returns immutable committed metadata.
 */
async addIdentifier(request: AddLoginIdentifierRequest): Promise<UserCredentialRecord>

/** Remove one normalized login identifier.
 * @param request - target, revision, raw identifier, and audit context.
 * @returns immutable committed metadata.
 */
async removeIdentifier(request: RemoveLoginIdentifierRequest): Promise<UserCredentialRecord>

/** Establish or administratively replace a password.
 * @param request - target, revision, new password, and audit context.
 * @returns immutable committed metadata without password material.
 */
async setPassword(request: SetPasswordRequest): Promise<UserCredentialRecord>

/** Atomically verify the current password and replace it.
 * @param request - target, revision, current and new passwords, and audit context.
 * @returns immutable committed metadata without password material.
 */
async changePassword(request: ChangePasswordRequest): Promise<UserCredentialRecord>

/** Disable password login without exposing or returning verifier material.
 * @param request - target, revision, and audit context.
 * @returns immutable committed metadata with password login disabled.
 */
async disablePassword(request: DisablePasswordRequest): Promise<UserCredentialRecord>

/** Verify a password with an enumeration-resistant boolean result.
 * @param request - resolved target when present and candidate password.
 * @returns true only for a matching enabled password; otherwise false.
 */
async verifyPassword(request: VerifyPasswordRequest): Promise<boolean>
```

Types: [UserId](user-directory.md)

Source: [`packages/identity/user-credential/src/index.ts:219`](../../packages/identity/user-credential/src/index.ts)

<a id="user-credential-events"></a>

### `user-credential/*` events

<a id="user-credentialchanged--emit"></a>

#### `user-credential/changed` — emit

Committed credential metadata change without identifiers or password material.

```ts cordis-catalog
/**
 * Committed credential metadata change without identifiers or password material.
 * @param event - sanitized fact safe for trusted audit listeners.
 * @mode emit
 */
'user-credential/changed'(event: UserCredentialChangeEvent): void
```

Source: [`packages/identity/user-credential/src/types.ts:129`](../../packages/identity/user-credential/src/types.ts)
<!-- END GENERATED cordis-surface -->
