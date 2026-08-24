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

`ctx.accounts` 协调持久化注册、密码登录、JWT 刷新/退出，以及资料和密码的自助修改。注册只返回 `UserRecord`；调用方需要再登录才能取得 access/refresh JWT 对。注册写入前，组合层必须通过 `ctx.accounts.registrationOperations.register(provider)` 注入唯一的持久化 `RegistrationOperationProvider`。Provider 按 request id 保存 `begin`/`advance`/`complete` 状态机，并通过 `read` 支持恢复工具。没有持久化 Provider 时默认失败；已经完成的重试返回同一个不含秘密的用户结果；部分提交只通过 `AccountRecoveryState` 报告恢复状态，不包含密码或 Token。

密码登录会用凭据元数据约束 JWT 签发。账号服务先解析用户并读取密码凭据 revision，完成密码认证并签发 JWT 对后再读取一次。只要所有者、revision 或密码启用状态发生变化，就会吊销刚签发的 Token family 并使登录失败，因此并发密码重置不会留下成功的旧状态登录。

自助资料修改只接受 `displayName`，extensions 只能由管理员修改。所有管理员方法都位于独立的 `ctx.accountAdministration` 服务。组合层必须通过 `ctx.accountAdministration.authorizers.register(authorizer)` 注入唯一的 `AccountAdminAuthorizer`。每次调用都会把当前操作者、准确 action 和可选 target 交给该 authorizer；缺少 authorizer 或 authorizer 拒绝时返回 `forbidden`，且不会执行修改。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxaccountadministration--accountadministrationservice"></a>

### `ctx.accountAdministration` — `AccountAdministrationService`

Explicit administrator capability guarded by one fail-closed authorizer.

```ts cordis-catalog
/** Create an account after explicit administrator authorization.
 * @param request - actor and registration input.
 * @returns committed account record.
 */
async adminCreate(request: AdminAccountCreateRequest): Promise<UserRecord>

/** Update a target after explicit administrator authorization.
 * @param request - actor, target, revision, and patch.
 * @returns committed target record.
 */
async adminUpdate(request: AdminAccountUpdateRequest): Promise<UserRecord>

/** Disable a target after explicit administrator authorization.
 * @param request - actor, target, revision, and lifecycle.
 * @returns committed disabled target.
 */
async adminDisable(request: AdminAccountStatusRequest): Promise<UserRecord>

/** Enable a target after explicit administrator authorization.
 * @param request - actor, target, revision, and lifecycle.
 * @returns committed active target.
 */
async adminEnable(request: AdminAccountStatusRequest): Promise<UserRecord>

/** Reset a target password after explicit administrator authorization.
 * @param request - actor, target, revision, and new password.
 * @returns committed credential metadata.
 */
async adminResetPassword(request: AdminPasswordResetRequest): Promise<UserCredentialRecord>

/** Revoke target sessions after explicit administrator authorization.
 * @param request - actor, target, and lifecycle.
 */
async adminRevokeSessions(request: AdminSessionRevokeRequest): Promise<void>
```

Types: [UserCredentialRecord](user-credentials.md) · [UserRecord](user-directory.md)

Source: [`packages/identity/account/src/index.ts:818`](../../packages/identity/account/src/index.ts)

<a id="ctxaccounts--accountservice"></a>

### `ctx.accounts` — `AccountService`

Coordinates users, credentials, authentication, and JWT lifecycle operations.

```ts cordis-catalog
/** Idempotently register one active account.
 * @param request - profile, identifier, secret, and operation lifecycle.
 * @returns the same committed user for every completed retry.
 */
async register(request: AccountRegistrationInput): Promise<UserRecord>

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
```

Types: [UserCredentialRecord](user-credentials.md) · [UserRecord](user-directory.md)

Source: [`packages/identity/account/src/index.ts:152`](../../packages/identity/account/src/index.ts)

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

<a id="ctxauthgateway--authgatewayservice"></a>

### `ctx.authGateway` — `AuthGatewayService`

Extracts bounded credentials and delegates only public account operations.

```ts cordis-catalog
/** Authenticate one HTTP access carrier.
 * @param request - structured headers, cookies, query, and lifecycle.
 * @returns Host-only call minted by the active authentication Provider.
 */
async authenticateHttp(request: GatewayHttpAuthenticationRequest): Promise<AuthenticatedCall>

/** Authenticate one WebSocket handshake without retaining raw carrier input.
 * @param request - structured handshake fields and lifecycle.
 * @returns Host-only call minted for the WebSocket channel.
 */
async authenticateWebSocket(request: GatewayWebSocketAuthenticationRequest): Promise<GatewayWebSocketAuthenticationResult>

/** Register an account without issuing credentials.
 * @param request - bounded profile, password, and lifecycle input.
 * @returns committed user record.
 */
async register(request: GatewayRegistrationRequest): Promise<UserRecord>

/** Password-login and place refresh material in an HttpOnly cookie.
 * @param request - bounded login body and lifecycle input.
 * @returns user, access token, and cookie directives.
 */
async login(request: GatewayLoginRequest): Promise<GatewaySessionResult>

/** Rotate the refresh cookie after Origin and double-submit CSRF checks.
 * @param request - structured browser request and lifecycle.
 * @returns replacement access token and cookie directives.
 */
async refresh(request: GatewayRequest): Promise<GatewaySessionResult>

/** Authenticate and revoke the current user's sessions.
 * @param request - HTTP bearer request and lifecycle.
 * @returns cookie clearing directives.
 */
async logout(request: GatewayHttpAuthenticationRequest): Promise<GatewayLogoutResult>

/** Revalidate an authenticated call immediately before protected handler use.
 * @param call - exact Host-only call returned by this gateway.
 * @param handler - protected operation that receives only the current call.
 * @returns handler result.
 */
guard<T>(call: AuthenticatedCall, handler: (current: AuthenticatedCall) => T | Promise<T>): T | Promise<T>
```

Types: [UserRecord](user-directory.md)

Source: [`packages/identity/auth-gateway/src/index.ts:205`](../../packages/identity/auth-gateway/src/index.ts)

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

Source: [`packages/identity/account/src/types.ts:205`](../../packages/identity/account/src/types.ts)

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
