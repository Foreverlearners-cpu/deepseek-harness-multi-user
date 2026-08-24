# 认证

[English](authentication.md) | 中文

认证子系统由 [`@deepseek-ai/dsh-auth`](../../packages/identity/auth/README.md) 提供。这个 Host 专用运行时根据提交的证据选择唯一 Provider，把已验证的主体事实记录在不可变的 `AuthenticatedCall` 中，并把可选的凭证生命周期操作交给拥有对应认证方式的 Provider。它只建立身份；授权和租户派生仍由独立消费者负责。

## Provider 选择

可信传输适配器提交一个 `AuthenticationAttempt`。证据种类只选择一个已注册 Provider；重复注册同一种证据或认证方式会在注册阶段失败。Provider 验证自己负责的原始凭证，并向运行时返回不含凭证秘密的身份事实。

## 调用来源

`authenticate()` 创建不可变的 `AuthenticatedCall`，并在当前进程记录它对应的有效 Provider 注册。只有原对象、Provider 仍然有效、取消信号尚未触发且认证结果未过期时，`assertCurrent()` 才会接受它。序列化或复制不能保留这项来源证明。

## 凭证生命周期

Provider 可以为自己拥有的凭证实现签发、刷新、查询和吊销操作。运行时根据认证方式路由操作，验证已签发凭证的元数据，并在操作不受支持时直接失败，不会猜测另一个 Provider。

## 审计事件

`auth/result` 报告请求身份、所选认证方式、已验证主体、结果和安全的失败类别。它绝不包含原始证据或已签发凭证的秘密值。

## 账号编排

`ctx.accounts` 协调用户、密码凭据和 JWT 生命周期服务，为 Host 提供注册、登录、自助和管理员操作。它保留各归属服务的乐观并发 revision 检查，在部分提交后报告不含秘密的恢复状态，并要求可信 Consumer 在调用管理员接口前完成授权。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccounts--accountservice"></a>

### `ctx.accounts` — `AccountService`

Coordinates users, credentials, authentication, and JWT lifecycle operations.

```ts cordis-catalog
/** Register an active account and issue its first JWT pair.
 * @param request - profile, identifier, secret, and operation lifecycle.
 * @returns committed user plus newly issued credentials.
 */
async register(request: AccountRegistrationInput): Promise<AccountSessionResult>

/** Authenticate a password, require an active user, and issue a JWT pair.
 * @param request - trusted transport login request.
 * @returns active user plus newly issued credentials.
 */
async login(request: AccountLoginRequest): Promise<AccountSessionResult>

/** Rotate a JWT refresh credential.
 * @param request - refresh secret and operation lifecycle.
 * @returns replacement access and refresh credentials.
 */
async refresh(request: AccountRefreshRequest): Promise<IssuedCredentialSet>

/** Revoke every JWT session owned by the current user.
 * @param call - exact current authenticated call.
 */
async logout(call: AuthenticatedCall): Promise<void>

/** Update the current user's profile with optimistic concurrency.
 * @param request - current call, expected revision, and profile patch.
 * @returns committed user record.
 */
async updateProfile(request: AccountProfileUpdateRequest): Promise<UserRecord>

/** Change the current user's password and revoke all existing JWT sessions.
 * @param request - current call, revision, old/new secrets, and lifecycle.
 * @returns committed non-secret credential metadata.
 */
async changePassword(request: AccountPasswordChangeRequest): Promise<UserCredentialRecord>

/** Create an account after the trusted caller authorizes the administrator.
 * @param request - authorized actor and new account values.
 * @returns committed account record without issued credentials.
 */
async adminCreate(request: AdminAccountCreateRequest): Promise<UserRecord>

/** Update a profile after the trusted caller authorizes the administrator.
 * @param request - authorized actor, target, revision, and patch.
 * @returns committed target record.
 */
async adminUpdate(request: AdminAccountUpdateRequest): Promise<UserRecord>

/** Disable a target and revoke all sessions after caller authorization.
 * @param request - authorized actor, target revision, reason, and lifecycle.
 * @returns committed disabled record.
 */
async adminDisable(request: AdminAccountStatusRequest): Promise<UserRecord>

/** Enable a target after caller authorization.
 * @param request - authorized actor, target revision, and reason.
 * @returns committed active record.
 */
async adminEnable(request: AdminAccountStatusRequest): Promise<UserRecord>

/** Reset a target password and revoke all sessions after caller authorization.
 * @param request - authorized actor, target credential revision, and new secret.
 * @returns committed non-secret credential metadata.
 */
async adminResetPassword(request: AdminPasswordResetRequest): Promise<UserCredentialRecord>

/** Revoke a target user's JWT sessions after caller authorization.
 * @param request - authorized actor, target, reason, and lifecycle.
 */
async adminRevokeSessions(request: AdminSessionRevokeRequest): Promise<void>
```

Types: [UserCredentialRecord](user-credentials.md) · [UserRecord](user-directory.md)

Source: [`packages/identity/account/src/index.ts:67`](../../packages/identity/account/src/index.ts)

<a id="ctxauth--authenticationruntime"></a>

### `ctx.auth` — `AuthenticationRuntime`

Authentication service that selects Providers and exclusively mints calls.

```ts cordis-catalog
/**
 * Verify carrier evidence through its sole Provider and mint an immutable call.
 * @param attempt - Host-owned request facts and untrusted carrier evidence.
 * @returns request identity accepted only by this live runtime.
 */
async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticatedCall>

/**
 * Require an exact call issued by this runtime whose request and Provider remain current.
 * @param value - candidate Host-only call.
 * @returns the same immutable call after validation.
 */
assertCurrent(value: unknown): AuthenticatedCall
```

Source: [`packages/identity/auth/src/index.ts:303`](../../packages/identity/auth/src/index.ts)

<a id="account-events"></a>

### `account/*` events

<a id="accountchanged--emit"></a>

#### `account/changed` — emit

Completed account orchestration fact without credential material.

```ts cordis-catalog
/**
 * Completed account orchestration fact without credential material.
 * @param event - sanitized account operation safe for audit listeners.
 * @mode emit
 */
'account/changed'(event: AccountChangeEvent): void
```

Source: [`packages/identity/account/src/types.ts:149`](../../packages/identity/account/src/types.ts)

<a id="auth-events"></a>

### `auth/*` events

<a id="authresult--emit"></a>

#### `auth/result` — emit

Completed authentication result without raw credential material.

```ts cordis-catalog
/**
 * Completed authentication result without raw credential material.
 * @param record - sanitized result safe for audit listeners.
 * @mode emit
 */
'auth/result'(record: AuthenticationEventRecord): void
```

Source: [`packages/identity/auth/src/types.ts:164`](../../packages/identity/auth/src/types.ts)
<!-- END GENERATED cordis-surface -->
