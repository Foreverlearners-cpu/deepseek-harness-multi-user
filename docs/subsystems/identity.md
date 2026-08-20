# Identity and Authorization

English | [中文](identity.zh.md)

The identity subsystem separates proof of caller identity from permission to perform a product action. [`dsh-authentication`](../../packages/identity/authentication/README.md) owns immutable Host-issued calls, while [`dsh-authorization`](../../packages/identity/authorization/README.md) owns the live permission catalog, default-deny decisions, and policy freshness. The [authorization architecture Agent Note](../../.agents/notes/implemented/architecture/2026-08-19-unified-authorization-for-plugins-disclosure-and-execution.md) records the cross-carrier design and deferred domain work.

## Authenticated calls

Transport adapters retain carrier evidence and submit it to the active `AuthenticationProvider` before parsing business payloads. A successful Provider verification produces an `AuthenticatedCall` containing the principal, tenant or platform scope, authentication method, request id, channel, cancellation signal, and optional expiry. The service records the exact frozen object and its issuing Provider privately; structural copies, JSON values, calls from another Provider, and expired credentials fail authentication.

[`dsh-authentication-local`](../../packages/identity/authentication-local/README.md) supplies an explicit single-identity Provider for loopback and same-process profiles. It does not infer identity from reachability, and Connection refuses to combine it with declared remote authorities.

## Permissions and decisions

Domains register stable `PermissionCode` definitions in `ctx.authorization.permissions`. Registration is effect-owned, duplicate active codes fail, unknown codes deny by default, and every catalog or Provider-policy change advances an opaque `PolicyVersion`. `decide()` returns an immutable allow or deny decision; `require()` returns only a current allow or throws a typed denial with a carrier-safe `UNAUTHENTICATED` or `FORBIDDEN` category.

For work that outlives one execution boundary, `openLease(request, decision)` converts a current allow into an `AuthorizationLease`. The lease signal aborts on call cancellation, credential expiry, policy or permission-catalog invalidation, and Authorization Provider disposal. Releasing the lease removes its expiry timer and revocation observers without aborting an operation that has already finished.

[`dsh-authorization-static`](../../packages/identity/authorization-static/README.md) provides explicit `deny-all` and `trusted-local` bootstrap policies. It grants no unregistered action and does not implement users, roles, tenant grants, or resource rules.

## Enforcement

An allow decision is consumed only while its call, permission definition, issuer, expiry, and policy version remain current. Asynchronous handlers call `assertCurrent()` immediately before lookup, source creation, method execution, or another protected effect. Long-running handlers open a lease after that final check and consume its signal for the rest of the operation. Gateway, generic RPC, legacy API routes, exports, SSE establishment, and WebSocket upgrade all authenticate before business parsing and authorize before invoking domain code.

Action authorization does not select tenant rows or redact fields. Each domain still owns resource-scoped queries, owner/share policy, typed projections, response filtering, and cache partitioning. Secured API Proxy SSE streams and Connection WebSocket downlinks keep one lease for the stream lifetime: request/socket cancellation and lease revocation abort the domain source, normal completion or consumer cancellation releases the lease, and policy/catalog invalidation, credential expiry, or Provider disposal closes an already-open stream. This is cooperative cancellation rather than JavaScript preemption; a future long-running domain operation must observe the lease signal and suppress effects or results after abort, because code that ignores `AbortSignal` cannot be forcibly stopped.

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
