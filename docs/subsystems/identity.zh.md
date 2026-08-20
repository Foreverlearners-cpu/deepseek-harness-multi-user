# 身份与授权

[English](identity.md) | 中文

身份子系统将调用方身份证明与执行产品操作的权限分离。[`dsh-authentication`](../../packages/identity/authentication/README.md) 拥有由 Host 签发的不可变调用，[`dsh-authorization`](../../packages/identity/authorization/README.md) 则拥有实时权限目录、默认拒绝决策和策略新鲜度。[授权架构 Agent Note](../../.agents/notes/implemented/architecture/2026-08-19-unified-authorization-for-plugins-disclosure-and-execution.md)记录了跨 carrier 设计与暂缓的领域工作。

## 已认证调用

传输适配器保留 carrier evidence，并在解析业务 payload 前把它提交给当前 `AuthenticationProvider`。Provider 验证成功后生成 `AuthenticatedCall`，其中包含 principal、tenant 或 platform scope、身份认证方式、request id、channel、取消 signal 和可选过期时间。服务会私下记录确切的冻结对象及其签发 Provider；结构复制、JSON 值、其他 Provider 的调用和过期 credential 均无法通过认证。

[`dsh-authentication-local`](../../packages/identity/authentication-local/README.md) 为回环与同进程 profile 提供显式的单身份 Provider。它不会从可达性推导身份，Connection 也拒绝将其与声明的远程 authority 组合。

## 权限与决策

领域在 `ctx.authorization.permissions` 中注册稳定的 `PermissionCode` 定义。注册关系由 effect 持有，重复的活动代码会失败，未知代码默认拒绝，每次目录或 Provider 策略变化都会推进不透明的 `PolicyVersion`。`decide()` 返回不可变的允许或拒绝决策；`require()` 只返回当前仍有效的允许，否则抛出带 carrier 安全 `UNAUTHENTICATED` 或 `FORBIDDEN` 类别的类型化拒绝。

对于跨越一次执行边界的工作，`openLease(request, decision)` 会把当前有效的 allow 转换为 `AuthorizationLease`。调用取消、凭证过期、策略或权限目录失效、以及 Authorization Provider 释放都会中止租约 signal。释放租约会移除其过期 timer 和撤销观察器，但不会中止一个已经完成的操作。

[`dsh-authorization-static`](../../packages/identity/authorization-static/README.md) 提供显式的 `deny-all` 与 `trusted-local` 引导策略。它不会授予未注册操作，也不实现用户、角色、tenant grant 或资源规则。

## 强制执行

只有调用、权限定义、签发者、过期时间和策略版本仍然当前有效时，允许决策才能被消费。异步 handler 会在 lookup、创建 source、执行方法或其他受保护 effect 前立即调用 `assertCurrent()`。长时间运行的 handler 会在这次最终检查后打开租约，并在操作的剩余生命周期消费其 signal。Gateway、通用 RPC、legacy API 路径、导出、SSE 建立和 WebSocket upgrade 都在解析业务内容前认证，并在调用领域代码前授权。

操作授权不会选择 tenant 数据行或脱敏字段。各领域仍拥有资源范围查询、owner/share 策略、类型化 projection、响应过滤和缓存分区。受保护的 API Proxy SSE 流和 Connection WebSocket 下行会在整个流生命周期持有一个租约：request／socket 取消和租约撤销都会中止领域 source，正常完成或消费方取消会释放租约，而策略／目录失效、凭证过期或 Provider 释放会关闭已经打开的流。这是协作式取消，不是 JavaScript 抢占；未来的长时间领域操作必须观察租约 signal，并在 abort 后抑制 effect 或结果，因为忽略 `AbortSignal` 的代码无法被强行停止。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthentication--authenticationprovider-abstract-seam"></a>

### `ctx.authentication` — `AuthenticationProvider` (abstract seam)

Provider base that exclusively mints immutable authenticated calls.

```ts cordis-catalog
/**
 * Verify carrier evidence and mint a call bound to its request, channel, and
 * cancellation signal. Provider-owned objects are copied before freezing.
 * @param attempt - Trusted transport input, never a business payload.
 * @returns A privately issued immutable call.
 * @throws {@link AuthenticationError} or a Provider-specific verification failure.
 */
async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticatedCall>

/**
 * Check that a call was issued by this live Provider instance.
 * @param value - Candidate call.
 * @returns Whether this Provider minted the exact call object.
 */
owns(value: unknown): value is AuthenticatedCall
```

Source: [`packages/identity/authentication/src/index.ts:144`](../../packages/identity/authentication/src/index.ts)

<a id="ctxauthorization--authorizationprovider-abstract-seam"></a>

### `ctx.authorization` — `AuthorizationProvider` (abstract seam)

Provider base owning default denial and live permission definitions.

```ts cordis-catalog
/**
 * Decide one registered action. Invalid calls, expired credentials, unknown
 * permissions, Provider failures, and policy changes during evaluation deny.
 * @param request - Complete trusted authorization input.
 * @returns Normalized decision carrying the policy version used.
*/
async decide(request: AuthorizationRequest): Promise<AuthorizationDecision>

/**
 * Require one action and retain any bounded obligations on success.
 * @param request - Complete trusted authorization input.
 * @returns Allow decision.
 * @throws {@link AuthorizationDeniedError} for every denial.
 */
async require(request: AuthorizationRequest): Promise<AuthorizationAllowDecision>

/**
 * Re-validate an allow decision immediately before consuming it.
 *
 * Authorization often crosses asynchronous lookup boundaries.  A decision
 * therefore cannot be treated as a durable capability: credentials may
 * expire and the Provider policy or permission definition may be replaced
 * while a Gateway is resolving arguments.  Consumers call this method at
 * each execution boundary and stop on a typed denial when the decision is no
 * longer valid.
 *
 * @param request - The same authenticated action request used for `require`.
 * @param decision - The allow decision being consumed.
 * @throws {@link AuthorizationDeniedError} when the call or policy is stale.
 */
assertCurrent( request: AuthorizationRequest, decision: AuthorizationAllowDecision, ): void

/**
 * Keep a previously allowed decision live across a long-running operation.
 * The returned signal aborts on caller cancellation, credential expiry,
 * policy/catalog invalidation, or Provider disposal. Consumers must release
 * the lease when their operation ends.
 * @param request - The same authenticated request used for `require`.
 * @param decision - Current allow decision being consumed.
 * @returns Revocable authorization lifetime.
 * @throws {@link AuthorizationDeniedError} when the decision is already stale.
 */
openLease( request: AuthorizationRequest, decision: AuthorizationAllowDecision, ): AuthorizationLease

/**
 * Compare a previously observed version with the live Provider policy.
 * @param version - Previously observed policy version.
 * @returns Whether it is still current.
 */
isCurrent(version: PolicyVersion): boolean
```

Source: [`packages/identity/authorization/src/index.ts:103`](../../packages/identity/authorization/src/index.ts)

<a id="authorization-events"></a>

### `authorization/*` events

<a id="authorizationdecision--emit"></a>

#### `authorization/decision` — emit

One normalized decision without resource contents or role-policy internals.

```ts cordis-catalog
/**
 * One normalized decision without resource contents or role-policy internals.
 * @param record - Safe decision record for audit Consumers.
 * @mode emit
 */
'authorization/decision'(record: AuthorizationDecisionRecord): void
```

Source: [`packages/identity/authorization/src/types.ts:154`](../../packages/identity/authorization/src/types.ts)

<a id="authorizationinvalidated--emit"></a>

#### `authorization/invalidated` — emit

Committed permission-catalog or Provider-policy invalidation.

```ts cordis-catalog
/**
 * Committed permission-catalog or Provider-policy invalidation.
 * @param next - Current version after the commit.
 * @param previous - Version invalidated by the commit.
 * @mode emit
 */
'authorization/invalidated'(next: PolicyVersion, previous: PolicyVersion): void
```

Source: [`packages/identity/authorization/src/types.ts:147`](../../packages/identity/authorization/src/types.ts)
<!-- END GENERATED cordis-surface -->
