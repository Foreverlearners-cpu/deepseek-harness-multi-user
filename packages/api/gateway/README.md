# @deepseek-ai/dsh-api-gateway

English | [中文](README.zh.md)

Two-sided Typert RPC endpoint for Host and Client Cordis environments. The Host entry provides `ctx.typertGateway`, while `@deepseek-ai/dsh-api-gateway/client` provides `ctx.remote`; both consume the same generated `InvocationDescriptor` contract and leave business selection to API Remotes and transport, request correlation, trust, and response envelopes to Connection. Every Remote explicitly selects authenticated or permission access. A permission-protected Remote receives a Host-only `AuthenticatedCall`; the call identity is never part of the Client signature or wire payload.

## Host service: `TypertGatewayService` (ctx key: `typertGateway`)

`ctx.typertGateway.invoke()` resolves the current descriptor and Cordis Service for each call, validates exact named arguments, resolves registered object or Context identities, invokes the public business method, and validates its result. Business Services extend `TypertRemoteService` and mark methods with `@Remote(options)` or `@RemoteScope(key, options)` from [`dsh-typert-protocol`](../../typert/protocol/README.md); each options object declares access explicitly, and `bindTypertRemote()` remains available when another base class owns inheritance.

Strict mode reads generated invocation descriptors from `ctx.typert.local`. Lookup parameters use the currently active resolver in `ctx.typert.lookups`: the business package registers the stable declaration and default policy, while Host composition can override resolution behavior with effect-scoped `configure()`; `@RemoteScope` resolves its receiver through a registered Host Context provider. SRC mode is a development fallback for endpoints that have never had a strict definition; it parses simple parameter names and accepts only JSON-safe values for non-lookup parameters. Withdrawing an observed strict definition fails instead of weakening validation.

The Host entry registers a trusted-host interceptor on Connection's shared `/api` FetchHandler. Connection passes this composite handler through its HTTP bridge; the handler dispatches claimed endpoints to Gateway and unclaimed endpoints to API Proxy. Direct `invoke()` calls preserve business errors; `TypertGatewayError` distinguishes failures owned by dispatch, binding, providers, lookup, Context, arguments, and codecs. A resolver may use `TypertLookupFailure` to carry an existing RPC error, preserving its original error code for policy rejections such as cold-resume failures or ownership fences.

A cancellation-aware Remote method declares `signal: AbortSignal` as its final Host parameter. The signal is descriptor metadata rather than a wire argument: Connection supplies it to the Gateway, and the Gateway injects it after decoded business parameters. SRC recognizes the reserved final name, while strict generation additionally requires the global `AbortSignal` type.

## Authorization boundary

`@Remote({ access: 'authenticated' })` and `@RemoteScope(key, { access: 'authenticated' })` require a valid Host-issued call without checking an action permission; they carry no `authorization` metadata and do not inject the call into the business method. A `permission` option selects permission access for either decorator. Its Host method must declare a non-optional first `call: AuthenticatedCall`; Typert records the permission and reserved parameter in `InvocationDescriptor`, then removes `call` from the Client signature and wire `args`. Bare decorators and string aliases are invalid.

Connection authenticates the original Host `Request` before invoking the handler. Gateway validates that call before descriptor or argument inspection, then completes permission authorization before exact argument validation, business lookup-provider resolution, and RemoteScope Context identity, Context, or scoped-receiver resolution. Missing or unknown descriptor access, an invalid access/authorization combination, or disagreement between a strict descriptor and its live marker is denied instead of falling back to authenticated or SRC execution. The marker and descriptor must agree on access, permission, endpoint alias, and direct or scoped invocation.

An allow decision is not a durable capability. Gateway calls `authorization.assertCurrent(request, decision)` before lookup and again immediately before method invocation, so Provider replacement, credential expiry, permission withdrawal, or a policy-version change during asynchronous lookup fails closed instead of consuming stale authority.

`AuthenticationError` maps to `unauthenticated`; `AuthorizationDeniedError` maps to `permission-denied` for policy denial. The latter includes only the permission code in RPC details; credentials, roles, and policy internals remain Host-local. Permission definitions are owned and registered by the domain package that exposes the Remote. A Client Context binder supplies a scope identity for convenience, not authority: raw RPC can name that identity directly, so a permission-protected scoped method still uses the injected call for owner, tenant, or resource checks owned by its domain.

## Client service: `ClientRemote` (ctx key: `remote`)

`ctx.remote.$mount()` validates and registers a generated Host-for-Client contribution, then installs concrete direct and scoped methods for the calling Cordis fiber. Each namespace is a traced `remote.<namespace>` child Service and unloads after its last method is withdrawn. Duplicate endpoints, namespace collisions, and descriptors without strict generated codecs fail before methods become callable.

Each call validates positional inputs, constructs the descriptor's exact named `args`, and sends it through `ctx.connection.rpc.call('/api', endpoint, ...)`. Generated cancellation-aware methods accept a final optional `AbortSignal`; the Client combines it with the contribution mount lifetime before calling Connection. The returned value is validated before reaching application code. Withdrawing a contribution removes its descriptors and methods together, aborts in-flight calls, and makes retained method handles reject.

`ctx.remote.$on()` subscribes to one forwarded Host event. Its legal keys are exactly the Host assembly's forwarding selection, and the listener type is the owning package's own Cordis `Events` declaration, so no second signature can drift from it. Each subscription belongs to the calling fiber and disappears with it. Delivery is one-way and follows registration order; a listener that throws is logged and isolated from the remaining listeners, which never affects the frame pump. `ctx.remote.$dispatch()` is the other half of that surface, and it is the carrier's: the Client half owning the Host frame sink hands each decoded frame over, and an event name nobody subscribes to is dropped, since the wire carries whatever the Host selected. A consumer subscribes and never calls it.

Generated declaration merges provide the TypeScript API through the shared `TypertClientRemote` contract. The Client entry contains no Host Service or Host Cordis interface merge, and method lookup and invocation use ordinary objects and functions rather than a JavaScript Proxy.

## Model Experience

None, as the package dispatches application calls and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; invoked business Services own any model-visible result.

## Known Limitations and Deferred Work

- The Connection adapter maps ordinary dispatch failures and business exceptions to the RPC `internal` code with the stable `handler failure` message and empty details; lookup-policy errors carried by `TypertLookupFailure` are returned unchanged. Structured `TypertGatewayError` categories remain available only to same-process callers.
- Remotes declared with `access: 'authenticated'` intentionally enforce identity only. Domains that expose actions or scoped resources still need owned permission codes and owner, tenant, or resource checks.
- SRC mode supports unique identifier parameters without destructuring, defaults, or rest parameters. It validates JSON safety rather than generated business types and never infers optional fields.
- Only strict generated contributions can mount on the Client face. SRC markers have no Client codec or type projection.
- The package dispatches unary methods only. Incremental Session data uses a separate named-stream protocol over the same Connection.
- Lookup resolvers are configured per key; an individual Remote parameter or endpoint cannot currently select a live-only policy under the same `agent`/`session` key.
- Forwarded events reach `$on` exactly as the Host emitted them: no payload projection or redaction, no Scope-bound subscription, and no replay after a reconnect.
