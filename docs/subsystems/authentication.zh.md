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

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Source: [`packages/identity/auth/src/index.ts:279`](../../packages/identity/auth/src/index.ts)

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

Source: [`packages/identity/auth/src/types.ts:163`](../../packages/identity/auth/src/types.ts)
<!-- END GENERATED cordis-surface -->
