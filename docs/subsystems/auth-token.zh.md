# Auth Token Family

[English](auth-token.md) | 中文

Auth-token 子系统是 [`@deepseek-ai/dsh-auth-token`](../../packages/identity/auth-token/README.md)，它是用于不透明 refresh-token family 状态的 Host-only Service Definition。它补充 [`dsh-auth`](authentication.md)：认证服务建立 principal 并分派 Credential Provider，而该服务为 JWT 和其他 Token Provider 提供可复用的轮换与撤销模型。

[`@deepseek-ai/dsh-auth-token-mysql`](../../packages/identity/auth-token-mysql/README.md) 是持久 MySQL Provider。它通过独立的 `ctx.mysql` 连接服务拥有只保存 digest 的 credential storage、schema version、行锁和原子 family 重用吊销。

## Secret 所有权

服务生成每个 refresh secret，并且只从 `issueFamily` 或 `rotate` 返回。Provider hook 接收 SHA-256 `RefreshTokenDigest`；检查结果和事件同时移除 secret 与 digest。存储 Provider 持久化 digest 行，传输 Consumer 决定怎样把返回的 secret 交给客户端。

## 原子生命周期

Family 具有一个绝对过期时间和单调 revision。创建从 revision 1 开始。轮换原子地把当前 Credential 标记为 `rotated`、插入一个 `active` 替代项并增加 revision。复用 rotated digest 时，调用失败前会原子撤销 family。按 Credential、family 或 principal 撤销保持幂等。

## Provider 与 Consumer 组合

具体 Provider 提供 `ctx.authTokens`，并拥有事务、锁、索引和持久性。JWT Provider 独立拥有 access-token 签名与验证，然后把 access Credential 与这里返回的 refresh Credential 组合起来。HTTP 和 gateway Consumer 拥有 bearer 或 Cookie 解析、CSRF 策略和公开错误映射。

## 审计

`auth-token/changed` 是供可信审计与失效 Consumer 使用的提交后进程内事件。它包含稳定 id、principal、revision、status、time 和 reason，但排除 Credential 材料与 Provider 诊断。持久审计投递需要 Provider 拥有的事务 outbox。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthtokens--authtokenservice-abstract-seam"></a>

### `ctx.authTokens` — `AuthTokenService` (abstract seam)

Abstract opaque refresh-token lifecycle. Providers own durable state and atomic commits; this base owns secrets, digests, validation, and events.

```ts cordis-catalog
/**
 * Atomically create one family and its first opaque refresh credential.
 * @param request - authenticated principal, absolute expiry, and operation lifecycle.
 * @returns committed safe family metadata and the only copy of the refresh secret.
 */
async issueFamily(request: TokenFamilyIssueRequest): Promise<TokenFamilyIssueResult>

/**
 * Atomically consume one refresh token and replace it exactly once.
 * Reuse revokes the entire family before the method rejects.
 * @param request - current refresh secret and operation lifecycle.
 * @returns committed family metadata and a replacement refresh secret.
 */
async rotate(request: RefreshTokenRotateRequest): Promise<TokenFamilyIssueResult>

/**
 * Inspect safe family and refresh-credential metadata.
 * @param request - credential, family, or principal target and operation lifecycle.
 * @returns immutable metadata without refresh secrets or digests.
 */
async inspect(request: AuthTokenInspectRequest): Promise<AuthTokenInspection>

/**
 * Idempotently revoke the family selected by a credential or family target,
 * or every active family belonging to one principal.
 * @param request - revocation target and operation lifecycle.
 */
async revoke(request: AuthTokenRevokeRequest): Promise<void>
```

Source: [`packages/identity/auth-token/src/index.ts:267`](../../packages/identity/auth-token/src/index.ts)

<a id="auth-token-events"></a>

### `auth-token/*` events

<a id="auth-tokenchanged--emit"></a>

#### `auth-token/changed` — emit

Committed token-family change without refresh secrets or digests.

```ts cordis-catalog
/**
 * Committed token-family change without refresh secrets or digests.
 * @param event - sanitized lifecycle fact safe for trusted audit listeners.
 * @mode emit
 */
'auth-token/changed'(event: AuthTokenChangeEvent): void
```

Source: [`packages/identity/auth-token/src/types.ts:214`](../../packages/identity/auth-token/src/types.ts)
<!-- END GENERATED cordis-surface -->
