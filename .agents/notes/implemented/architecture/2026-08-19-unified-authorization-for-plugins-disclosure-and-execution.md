# Agent Note: Unified authorization for plugins, disclosure, and execution

Status: implemented

English | [中文](2026-08-19-unified-authorization-for-plugins-disclosure-and-execution.zh.md)

## Problem

The existing Host/Origin checks establish transport trust, while permission presets and approval services constrain execution. None of those mechanisms establishes the caller identity for a business operation or gives Remote methods and plugin projections a shared permission contract. Hiding a menu item also does not protect a direct RPC, and exposing a complete projection before filtering is already a disclosure.

The first shipped slice needed to establish this boundary without prematurely introducing a role-management UI, a database schema, or a migration of every domain. It also needed an explicit local composition so existing local profiles could opt in without treating sandbox or approval policy as account authorization.

## Decision

The repository now has separate authentication and authorization Service Definitions. Protected Host boundaries carry an explicit, immutable `AuthenticatedCall`; authorization is a second check over a registered `PermissionCode`. The call is never inferred from a Session id, accepted from RPC JSON, or stored as mutable current-user state.

### Authentication contract

`@deepseek-ai/dsh-authentication` owns the issuer boundary. An `AuthenticationProvider` verifies trusted carrier evidence and mints a frozen call containing the request id, carrier channel, principal, authentication method, tenant/platform scope, cancellation signal, and optional expiry. A private process-local `WeakSet` is authoritative in `isAuthenticatedCall`, so a structural copy or JSON round trip cannot be used as a call. Provider failures have stable public `unauthenticated` or `authentication-unavailable` categories.

The shipped `@deepseek-ai/dsh-authentication-local` provider is intentionally explicit: its configuration names a local principal, tenant, and membership. It is not a fallback inferred from loopback or an anonymous id. The Host Connection HTTP adapter authenticates while it still owns the original `Request`; the identity is passed to the handler separately and never enters the RPC wire payload. Missing authentication is a request-time failure, so a Connection cannot silently turn an unauthenticated request into a trusted call.

### Authorization contract

`@deepseek-ai/dsh-authorization` owns the decision lifecycle and distributed permission catalog. Domains register immutable definitions with an owner, description, and disclosure class. Registration is effect-scoped, rejects duplicate active codes, and changes the opaque policy version. The central package validates the stable `domain:action` syntax but does not own a giant domain enum.

An authorization request contains an `AuthenticatedCall`, a branded permission, and optional domain resource/environment data. `decide()` and `require()` reject forged calls, expired calls, unknown permissions, Provider exceptions, and policy changes observed during evaluation. `require()` raises `AuthorizationDeniedError`; decision events contain a safe reason, request correlation data where available, and no credential or role details. `authorization/invalidated` is emitted when the policy/catalog version changes, and callers can use `isCurrent()` to reject stale decisions.

For a long-running operation, `openLease(request, decision)` first performs the same current-decision check and then returns an `AuthorizationLease`. Its signal aborts on the authenticated call's cancellation, credential expiry, any policy or permission-catalog invalidation, and Authorization Provider disposal. `release()` removes the lease from Provider observation without aborting a completed operation. The lease is a revocable lifetime, not a durable capability or a copy of policy state.

The static Provider package, `@deepseek-ai/dsh-authorization-static`, has only two explicit modes: `deny-all` and `trusted-local`. The latter allows registered actions only for an authenticated `local` principal. This Provider is a bootstrap/local test implementation, not a role or membership store. Authorization remains independent from sandbox, approval, and permission presets.

### Enforcement and generated contracts

Every Typert `@Remote(options)` and `@RemoteScope(key, options)` marker requires an options object with one explicit access branch:

```ts ignore-check
@Remote({ access: 'authenticated' })
@Remote({ exportName: 'list', permission: 'plugin:metadata-read' })
```

The authenticated branch requires `access: 'authenticated'`, accepts only a valid Host-issued call, carries no authorization metadata, and does not inject the call into the business method. The permission branch is selected by `permission`; its direct or scoped Host method declares a non-optional first `call: AuthenticatedCall`, which is omitted from wire arguments and generated Client signatures. Bare decorators and string aliases are invalid.

Every Gateway invocation first verifies that the call belongs to the active Authentication Provider and has not expired. For a permission descriptor, authorization completes before exact Remote argument validation, business lookup-provider resolution, and RemoteScope Context identity, Context, or scoped-receiver resolution; the decision is checked again immediately before invocation. `access` is a required closed discriminant. Generation, Loader, and registry validation reject missing or unknown access and every inconsistent access/authorization combination. A strict descriptor and its live marker must agree on access, permission, endpoint alias, and direct or scoped invocation, with no fallback to authenticated or SRC execution.

This creates a reusable operation boundary, but it does not claim that one Gateway check replaces resource-owner or projection checks. A Client Context binder is not authority because raw RPC can supply the scoped identity directly; the domain still uses the injected call for owner, tenant, resource, and projection checks. No global mutable principal or implicit authorization context was added.

### Shipped vertical slice: plugin inventory

`@deepseek-ai/dsh-host-plugin-inventory` owns two permission definitions:

| Permission | Disclosure | Returned projection |
| --- | --- | --- |
| `plugin:discover` | discovery | Non-group Loader entry ids only |
| `plugin:metadata-read` | metadata | Entry id, package/module name, enabled state, and Fiber phase |

Both the Gateway descriptor and the domain method call `ctx.authorization.require()`. The method reads the current Loader state for each request, so the inventory does not create a second lifecycle cache. An unauthorized caller cannot obtain these projections through the direct Remote path even if the UI omits them.

The base bundle explicitly mounts local authentication and `trusted-local` authorization. The existing `permission-presets` row remains the sandbox/approval selection and is not used as an account grant.

### Failure and disclosure semantics shipped here

Public RPC mapping distinguishes `unauthenticated` from `permission-denied` without returning internal policy reasons. Authorization failures do not reveal role graphs, credential material, or Provider diagnostics. The legacy API route map now gives Session, Tool, Settings, event, prompt, export, and bundle surfaces an operation-level permission gate; it still does not provide a general redaction/resource-filtering engine or imply that every returned projection is tenant- or resource-scoped.

### Legacy API carrier enforcement

The legacy API Proxy is now behind the same identity and permission contracts when mounted by `client/connection`. Its route map is a stable, compile-locked policy surface:

| Route family | Permission codes |
| --- | --- |
| Session list/search/models | `api:session-list` |
| Session history/attachments | `api:session-history` |
| Session create/write/cancel | `api:session-write` |
| Session prompt | `api:session-prompt` |
| Subagent list/history/prompt/write | `api:subagent-list`, `api:subagent-history`, `api:subagent-prompt`, `api:subagent-write` |
| Host read/write/native | `api:host-read`, `api:host-write`, `api:host-native` |
| Workspace read/write | `api:workspace-read`, `api:workspace-write` |
| Skill and agent-preset inventory/use | `api:skill-list`, `api:agent-preset-list`, `api:agent-preset-metadata-read`, `api:agent-preset-use`, `api:agent-preset-write`, `api:agent-preset-native` |
| Goals | `api:goal-write` |
| Settings and credentials | `api:settings-read`, `api:settings-write`, `api:settings-native`, `api:credentials-read`, `api:credentials-write` |
| LLM catalog/discovery | `api:llm-read`, `api:llm-discover` |
| Downlinks, export, and responses | `api:events-mux`, `api:events-host`, `api:session-export`, `api:respond` |

For network requests, the Connection adapter authenticates the original `Request` before JSON parsing, query parsing, or domain dispatch. Unary POSTs, `POST /api/respond`, `GET|HEAD /api/session.export`, and in-process SSE `GET /api/events.mux` / `GET /api/events.host` all authorize their route. A refusal before body parsing uses the reserved `security-denied` rpcId, accepted by clients only for `unauthenticated` and `permission-denied`; `/api/respond` uses HTTP 401/403 because its response contract is a receipt rather than an RPC envelope. The WebSocket upgrade path applies the Host/Origin trust fence first, then authenticates and authorizes the matching downlink before opening the source. Unauthorized requests therefore do not receive a payload or session-id oracle, and unexpected Gateway/SSE/WebSocket errors expose only `handler failure`. `toFetchHandler(api)` remains usable without security options for pure in-process protocol tests; the production Connection mount always supplies the security adapter.

The adapter re-checks the opaque authorization decision immediately before consuming a route. Gateway-protected Remotes perform the same freshness check before receiver lookup and again directly before business invocation. Expiry and policy-version invalidation therefore close the lookup/dispatch race for these boundaries. After the final stream check, SSE and WebSocket paths open a lease before creating their source. SSE merges the request and lease signals, closes cleanly on revocation without emitting a false `handler failure`, and releases on source completion or consumer cancellation. WebSocket consumes the same lease signal by aborting its source and closing the accepted socket with policy code 1008 and a generic reason; owned close and handled negotiation-failure paths release the lease, and the acceptor remains available for a newly authenticated connection. This covers mid-stream call cancellation, credential expiry, policy/catalog invalidation, and Provider disposal without per-frame re-decision.

Lease cancellation is necessarily cooperative inside JavaScript. The Provider can abort the signal and carriers can stop delivery, but it cannot preempt synchronous code or an asynchronous domain operation that ignores `AbortSignal`. Every future non-carrier long-running consumer must pass the signal into its work, suppress effects or final results after abort, and release in cleanup.

The local bootstrap composition is deliberately constrained. `authentication-local` advertises `localOnly`; Connection rejects combining it with non-empty `trustedHosts`, and host-native/configuration/plugin-authoring operations remain loopback-only even when another provider trusts network authorities. On a real Node request, a loopback Host must also have a loopback TCP peer (`127/8`, `::1`, or IPv4-mapped loopback), closing client-controlled `Host: localhost` spoofing on all-interface listeners. A remote or multi-principal deployment must mount a network-capable Authentication Provider and explicit grants; Host/Origin trust is never a substitute for identity.

## Package topology

| Package | Shipped responsibility |
| --- | --- |
| `identity/authentication` | Branded principal/scope ids, verified call contract, issuer check, Provider base, public authentication errors |
| `identity/authentication-local` | Explicit local synthetic identity Provider |
| `identity/authorization` | Permission catalog, decision/require API, revocable authorization leases, default-deny normalization, policy versions, invalidation and denial records |
| `identity/authorization-static` | Explicit `deny-all` and `trusted-local` Provider |
| `client/connection` | Authenticate Host HTTP and WebSocket requests, enforce legacy route permissions, open and consume stream leases, and pass calls out-of-band to handlers |
| `api/gateway` | Enforce Remote descriptors, inject Host-only calls, map authorization failures |
| `typert/protocol`, `generator`, `loader`, `registry` | Require and validate Remote access discriminants; hide permission-method call parameters from Client wire contracts |
| `host/plugin-inventory` | Own plugin discovery/metadata permissions and filtered Loader projections |
| `bundle/base` | Explicitly mount local authentication and authorization Providers |

## Alternatives considered

**Use frontend hiding as the security boundary.** Rejected because a direct endpoint or guessed Remote can bypass it, and data is disclosed as soon as an unfiltered response reaches the Client. UI state is only a presentation hint.

**Treat permission presets, sandbox policy, or approval as account authorization.** Rejected because those mechanisms constrain execution or record current human consent; they do not authenticate a principal or grant a product action.

**Derive identity from loopback, anonymous ids, Session ids, or RPC payload fields.** Rejected because business input cannot establish its own actor or tenant. Carrier-owned evidence must be verified by an Authentication Provider.

**Store the current principal in mutable Context state or ambient async state.** Rejected because detached work and concurrent calls can observe the wrong caller. Protected methods receive the call explicitly.

**Start with MySQL roles and an administration UI.** Rejected for this slice because persistence would freeze policy and disclosure semantics before enforcement points were proven. A later Provider can implement the same contract.

**Authorize only at transport or Gateway.** Rejected as a complete model because resource lookup, filtering, serialization, events, and other domain owners need their own scope and disclosure checks. The shipped Gateway check is the first enforcement layer, not a blanket claim about every domain.

## Consequences

Explicit permission-method call parameters and closed Remote access descriptors make identity visible at package boundaries and prevent the Client wire contract from carrying forgeable identity. The private issuer check, default-deny normalization, policy-version invalidation, revocable operation lifetime, and typed public errors provide a stable foundation for future Providers. Permission ownership stays with the domain that owns the returned data, demonstrated by plugin inventory rather than a central list of arbitrary endpoint names.

The trade-off is a compatibility surface across Connection, Gateway, and generated Typert artifacts. Every Remote requires an explicit access declaration and a valid identity; permission-protected methods must additionally declare and enforce a permission, and their tests must cover both a valid issued call and forged or denied calls. The static local Provider grants no user model, resource sharing, or persistence. Authenticated Remotes and resource-owning domains still need action-permission migration where identity alone is insufficient, and adding a permission marker alone does not supply tenant or resource filtering.

## Testing and verification

The implemented tests cover authentication issuance, freezing, structural forgery, JSON round trips, expiry, local configuration validation, permission-code/catalog validation, default denial, unknown permissions, Provider failure, stale decisions, policy invalidation, static Provider modes, and Service Definition lifecycle invariants. Lease tests cover policy/catalog invalidation, credential expiry, call cancellation, release, and Authorization Provider disposal. API Proxy and Connection carrier tests cover SSE revocation cleanup, stale lease-open refusal, WebSocket policy closure, source cancellation, one-time release, the accept-race, and continued acceptor availability. Gateway and Connection tests also cover authentication ordering, forged calls, explicit Remote access, inconsistent descriptors, protected Remote enforcement, and public RPC error mapping. Plugin inventory tests cover separate discovery/metadata projections and direct domain denial.

The remaining scope is deliberately explicit: OIDC/token adapters, role and grant persistence, tenant/resource ABAC and general resource filtering, audit storage, capability tokens for dynamic execution, Client authorization snapshots, adoption of leases by other long-running domain operations, action-permission migration for authenticated Remotes, and migration of other disclosure owners are follow-up architecture work. The Node bridge also buffers up to `maxRequestBodyBytes` before Fetch-layer credential authentication, so a streaming Request or authenticated bridge preflight remains needed for credential-level resource-DoS resistance. Plugin inventory has a narrow filtered projection, but there is no repository-wide redaction/resource-filtering engine yet. These follow-ups must reuse these contracts rather than silently expanding `trusted-local` or the permission preset system.
