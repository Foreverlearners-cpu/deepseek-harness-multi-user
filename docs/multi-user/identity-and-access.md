# Multi-user identity and access

English | [中文](identity-and-access.zh.md)

This reference defines the proposed identity, authentication, authorization, and administration model. It assumes the deployment architecture in [the multi-user overview](README.md) and does not describe shipped APIs.

## Identity model

The control plane owns four branded internal identities:

- `UserId` identifies a human account and never changes when an email address, display name, or upstream identity changes.
- `TenantId` identifies one administrative and data-isolation unit. A new user receives a personal tenant; organizations use additional tenants rather than changing user identity.
- `MembershipId` joins one principal to one tenant with lifecycle state and authorization assignments. Human memberships carry one or more active role assignments; service-account memberships carry bounded action grants and cannot hold tenant-owner authority. Disabled or removed membership invalidates future authorization even while the principal remains valid.
- `ServiceAccountId` identifies non-human automation. Its credentials, grants, expiry, and revocation are independent of a human login session, and it reaches tenant resources only through an active membership.

A local profile additionally owns a composition-only `LocalPrincipalId`; it is not a control-plane account and is never accepted by a server profile.

An authenticated principal is a user, service account, or local principal plus authentication facts. A call becomes tenant-scoped only after the control plane resolves an active membership, or after a local composition resolves its synthesized personal tenant and membership. The selected `TenantId` is trusted context, not ordinary endpoint input.

External OIDC `issuer + subject` pairs map to `UserId`. Email is profile data and may help an invitation flow, but it is neither unique identity nor authorization evidence. The control plane stores no model-provider credential in an authentication record.

## Authentication

Browser deployments should delegate login to an OpenID Connect provider using Authorization Code with PKCE. The Host receives a short-lived, Secure, HttpOnly, SameSite cookie; browser JavaScript never receives refresh credentials. State-changing cookie-authenticated calls require CSRF protection in addition to the existing Host and Origin checks. Production remote access requires TLS at the reverse proxy or application edge.

SDK and automation clients use short-lived OAuth access tokens or scoped service-account tokens. Long-lived personal tokens, if supported, are shown once, stored only as a strong one-way verifier, carry explicit tenant/action scopes and expiry, and can be individually revoked. ACP or JSON-RPC serving over a remote transport follows the same principal contract; stdio-only local automation may use the explicit local principal.

The local `web` and `headless` profiles synthesize a `LocalPrincipal` bound to one personal tenant. This is a composition choice available only to local profiles. A server profile fails at boot when no authentication provider is mounted and never converts loopback, `trustedHosts`, an OS username, or an anonymous Harness-home id into a remote principal.

Authentication validates issuer, audience, signature, expiry, not-before time, token type, and provider-specific nonce/state requirements. Key rotation and identity-provider outages fail closed for new calls. Revocation semantics and maximum session age are deployment tunables, not hardcoded plugin constants.

## Authenticated and scoped call contexts

Every transport adapts a verified credential into the exact immutable `AuthenticatedCall` defined by `dsh-auth` before API Proxy or Typert method resolution. It contains identity and authentication facts only. `dsh-tenant-scope`, the control-plane adapter, or the local composition then validates active membership, operator state, or the local profile and mints a provenance-bearing scope in a separate trusted authorization context:

```text
AuthenticatedCall = {
  requestId,
  principal,
  channel,
  method,
  signal,
  credentialId?,
  authenticatedAt,
  expiresAt?
}

AuthorityCallContext = {
  call: AuthenticatedCall,
  scope:
    | { kind: "tenant", tenantId, membershipId }
    | { kind: "platform", operatorGrantId }
}
```

The `AuthorityCallContext` is passed through handler and service APIs that perform protected operations. It is not trusted merely because its fields have the right shape. On every protected operation, `dsh-authority` proves the exact call is still current, verifies the scope was minted by the active adapter, and re-resolves that the membership belongs to the call principal and tenant or that the active operator grant belongs to the call user. Tenant product APIs accept only the tenant variant; the platform variant is accepted only by control-plane management APIs and cannot be forwarded as tenant authority. Endpoint payloads contain resource ids and business inputs, not an authoritative `userId` or `tenantId`. This explicit parameter keeps authorization visible at package boundaries and avoids relying on mutable process globals or an implicit asynchronous-local value.

HTTP creates one authenticated call and scoped context per request. WebSocket authentication occurs before upgrade; the connection pins the principal and active tenant for its lifetime, and membership revocation closes or reauthorizes the stream within a bounded interval. Reconnect performs authentication again. In-process carriers use the same two-stage context path rather than bypassing policy because no network was crossed.

Internal calls between a control plane and tenant runtime use a mutually authenticated channel or a same-process capability that cannot be constructed by untrusted plugin input. Because an `AuthenticatedCall` has process-local provenance and cannot be serialized, the target runtime authenticates a short-lived forwarding assertion through its own Provider and derives a new local call and scope. The assertion restricts audience to one runtime and includes request id, principal id, tenant id, and an action ceiling; that ceiling narrows credential use but is not an upstream authorization result, so the runtime still evaluates its full functional, relationship, and guard routes.

## Authorization

Authorization has two cooperating owners:

- The policy service decides whether an authenticated actor may perform an action under a membership, role, resource classification, and deployment policy.
- The resource service loads or mutates data only inside the authenticated tenant and verifies resource-specific ownership. It never accepts a prior boolean as proof and never offers an unscoped fallback method to a remote caller.

The first release uses a small human role baseline: tenant `owner`, tenant `admin`, and tenant `member`, plus a separate platform `operator` role. A human membership may combine active role assignments; its functional permission is their union. Service accounts receive bounded action grants directly and cannot become tenant owners or platform operators. Platform operators manage deployment health, suspension, quotas, and routing; they do not automatically receive tenant transcript or secret access. Tenant owners manage membership and tenant policy. Tenant admins manage tenant resources allowed by policy. Members manage their own sessions and use authorized tenant workspaces.

Actions are domain-specific and stable, for example `session:create`, `session:read`, `session:steer`, `session:approve`, `session:export`, `workspace:manage`, `settings:user-write`, `settings:tenant-write`, `credential:use`, `credential:manage`, and `membership:manage`. A role maps to actions; endpoint names do not become the authorization model.

Resource lookup is scoped before data leaves its owner. Session persistence queries by `(tenantId, sessionId)`, workspace queries by `(tenantId, workspaceId)`, and attachment resolution requires an authorized session reference. A caller presenting another tenant's valid id receives the same public not-found response as a nonexistent id. The audit record may retain the denied target hash and denial reason without exposing them to the caller.

List, search, count, export, fork, resume, and event subscription are authorization operations too. A service that filters only `get()` but leaves an unscoped `list()` or all-session stream remains insecure. Cold-session resume repeats authorization before preparation and again before publication if membership state can change during the read.

## Session ownership and approvals

A session has immutable `tenantId` and `ownerPrincipal` metadata. `ownerPrincipal` is a discriminated `SessionOwner`: a `UserId`, `ServiceAccountId`, or local-profile-only `LocalPrincipalId`, never an untyped id. The authenticated creator supplies neither value directly; the session factory stamps both from the tenant call context. A server composition rejects a local owner. Forking stays inside the tenant and preserves the owner unless an explicit sharing or transfer operation is introduced. Cross-tenant copy is an export/import workflow that creates new ids, validates attachments, and writes a separate audit trail.

Only the session owner may steer or cancel in the first release. A human-owned session permits only that user to answer questions or grant interactive tool approval. A service-account-owned session uses pre-authorized policy and cannot impersonate a human approver; a later delegation design must name an explicit human approver. Tenant administration does not silently confer approval authority because an approval can widen filesystem or process access. A future collaborative session design must define editor and approver grants separately, attribute every durable human input, and settle concurrent turn ownership before enabling shared mutation.

Session read access is private by default. Tenant owners and platform operators can manage retention, suspend execution, or delete through explicit administrative actions without receiving transcript bodies. Break-glass content access, if a product requires it, needs a separate grant, reason, short lifetime, prominent audit event, and user-visible policy; it is not implied by an `admin` label.

## Administration

The control-plane management API owns user status, tenant lifecycle, membership invitations, role changes, service accounts, token revocation, quotas, retention, and runtime assignment. These methods are separate from tenant product APIs and require fresh authorization on every call. Management pages consume dedicated projections and never reuse unrestricted `settings.describe`, `credentials.describe`, or global session lists.

Bootstrap creates the first platform operator through an out-of-band deployment action. Normal product traffic cannot promote a user to platform operator. Impersonation is omitted initially; adding it requires a distinct impersonated-principal field, immutable original actor, bounded lifetime, visible indicator, restricted actions, and complete auditing.

Every privileged mutation uses optimistic concurrency or a transactional precondition so two administrators cannot overwrite membership, role, quota, or policy state from stale pages. Deactivation revokes new calls immediately, prevents new runtime work, and triggers bounded cancellation or transfer policy for already-running sessions.

## Audit requirements

Authentication and authorization emit security audit records for login success/failure, token creation/revocation, tenant selection, membership and role changes, denied protected actions, credential administration, session export/delete, approval decisions, policy changes, and operator actions. The [data and runtime isolation reference](data-and-runtime-isolation.md) owns the audit record and retention rules.

Diagnostics returned to users name the failed action and a safe correction without disclosing another tenant's resource, role graph, credential state, or internal policy. Operational logs correlate by request id and internal opaque ids; authentication tokens, cookie values, credential values, message bodies, and tool output are excluded.
