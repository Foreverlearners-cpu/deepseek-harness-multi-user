# Multi-user delivery plan

English | [中文](delivery-plan.zh.md)

This plan orders the proposed multi-user work so each phase establishes a security property that later phases can rely on. It is not a compatibility promise or implementation status page. The target rules live in [the overview](README.md), [identity and access](identity-and-access.md), and [data and runtime isolation](data-and-runtime-isolation.md).

No intermediate phase is a deployable multi-user server. The server profile remains unavailable to mutually untrusted users until phases 0 through 5 satisfy their exit criteria together; phase 6 remains optional.

## Phase 0: freeze the threat model

Define the supported deployment modes before changing service signatures:

- Local mode has one explicit local principal, one personal tenant, trusted local files, and local execution providers.
- Server mode has authenticated remote clients, mutually untrusted tenants, private sessions, tenant runtimes, and container-class execution.
- Platform operators are operational administrators without implicit tenant content or secret access.
- Collaborative sessions, cross-tenant sharing, and custom password authentication are outside the first release.

Record branded ids, action names, public not-found behavior, audit requirements, principal revocation timing, and which providers qualify for server mode. Add a composition invariant that rejects a server profile containing an anonymous transport, local secret file provider, unrestricted Host filesystem provider, local subprocess/PTY provider, or worker-thread code/workflow engine unless the deployment explicitly declares a trusted single-tenant mode.

## Phase 1: identity and control plane

Add the proposed `dsh-mysql` infrastructure service, then complete capability families for authentication, authorization, tenancy, and audit. Authentication includes a Service Definition, OIDC/service-token providers, and transport consumers. Authorization includes the policy service, role/membership provider, and protected resource consumers. MySQL-backed domain Consumers own identity, membership, role, token-metadata, and audit schemas; audit includes an append API, durable provider, and administrative query/export consumer.

Change Connection handlers and Typert Host invocation to receive `AuthenticatedCall`. Authenticate HTTP before body dispatch and WebSocket before upgrade. Make in-process, test, ACP, and SDK carriers provide an explicit principal. Preserve the Host/Origin DNS-rebinding fence as defense in depth; it neither creates a principal nor substitutes for CSRF protection.

Deliver management APIs for user status, tenants, memberships, roles, service accounts, token revocation, and runtime assignment. Add a minimal management UI only after the methods enforce policy independently. Bootstrap the first platform operator out of band.

Exit criteria: no server endpoint or stream opens without a principal; a user with memberships in two tenants cannot select an unjoined tenant; revocation prevents new calls within the documented bound; admin methods cannot be reached through tenant product remotes.

## Phase 2: tenant-owned persistence

Extend `SessionHeader`, session factories, persistence interfaces, and both local SQLite schemas with immutable tenant and discriminated `SessionOwner` metadata. Add `dsh-session-persistence-mysql` as the server provider over `dsh-mysql`. Replace process-local session ids with collision-resistant ids. Change every persistence read/list/fork/export/repair path and session-query provider to require tenant scope.

Create a new tenant-aware schema version rather than accepting old rows under inferred ownership. Add a separate import command that reads one trusted single-user store and writes it into a selected personal tenant after a complete dry-run report. It assigns ownership, rewrites physical locations, validates attachment references, and is restartable; server startup never performs implicit migration.

Scope storage-domain units and workspace registry global state by tenant. Add deployment/tenant/user settings layers and scoped credential identities. Introduce a server credential provider backed by a maintained vault or secret service. Keep local file providers available only in local composition.

Exit criteria: direct access to persistence, storage-domain, settings, credentials, workspace, attachments, and search with another tenant's valid id returns no data; all writes include tenant ownership; database constraints prevent cross-tenant event/session and workspace/session references.

## Phase 3: API, stream, and live-state isolation

Convert API Proxy and business Remote methods to accept access context at their protected owner. Remove or make internal every unscoped `get`, `list`, `describe`, resume, export, and mutation route reachable from remote code. Authorization occurs before cold session preparation and before publishing a resumed agent.

Replace all-session mux/Host streams with authenticated subscriptions. Build baselines from authorized resources and register tenant/session-scoped listeners. Key live agent maps, prepared caches, resume deduplication, retirement chains, pending approvals/questions, jobs, terminals, projection caches, title state, and search state by tenant or place them wholly inside one tenant runtime. Redis may carry cache, leases, rate limits, and scoped pub/sub; Elasticsearch may serve tenant-scoped search, but both consume a durable MySQL outbox and remain rebuildable derived state.

Exit criteria: two connected users in different tenants receive no frame, count, timing-dependent queue behavior, pending interaction, workspace change, or host event from the other tenant; membership removal closes or reauthorizes active streams; reconnect cannot recover a revoked baseline.

## Phase 4: execution isolation

Define `ExecutionLease` and route filesystem, subprocess, shell, terminal, LSP, code runtime, workflow, hooks, session command jobs, and every subagent's execution-capability calls through the same session execution world. Agent orchestration may remain in the tenant runtime but has no server-mode path to Host-local execution providers. Add a production container or microVM provider with bounded provisioning, resource quotas, network policy, short-lived credential delivery, complete process-tree teardown, and observable quiescence.

Server composition never mounts arbitrary Host directories or process-wide provider credentials into the execution world. Workspace provisioning produces an authorized volume or checkout. Spills, output files, PTY state, worker control files, and temporary uploads live within the lease or a tenant/session-owned object store.

Exit criteria: model code cannot read Host settings, control-plane credentials, another tenant's volume, runtime control state, or another session's temporary artifacts; cancellation and runtime disposal revoke credentials and leave no observable process; quota exhaustion is contained to the owning tenant/session.

## Phase 5: administration and operations

Add quota accounting, retention, deletion, export, tenant suspension, runtime health, backup/restore, audit search/export, and billing/usage projections as separately authorized control-plane capabilities. Content deletion covers the session row, events, attachment references, spills, derived indexes, cached projections, and execution artifacts under one durable deletion job; audit policy retains only the required deletion fact.

Use structured operational logging with request, tenant, runtime, and resource ids. Default content telemetry to disabled in server mode. Add tenant policy and user disclosure before any prompt/tool content export. Platform health views operate on aggregate or redacted facts and do not call tenant transcript APIs.

Exit criteria: a suspended tenant cannot start new work; quotas remain correct under retries and concurrent requests; deletion and export are restartable and scoped; restore cannot place data into the wrong tenant; operator workflows leave complete audit records without exposing secret values.

## Phase 6: optional collaboration

Design session sharing only after private multi-user operation is stable. Define reader, editor, and approver grants separately; attribute every human-authored durable input; serialize or arbitrate concurrent turns; define who owns costs and credentials; specify revocation, fork, export, and notification behavior.

This phase is not required to call the deployment multi-user. Deferring it avoids coupling basic account isolation to a distributed collaborative editor and prevents tenant admin from accidentally becoming an execution approver.

## Verification matrix

Every protected acceptance path needs a paired denial using real assembled entry points. Unit tests alone do not establish multi-user isolation.

| Surface | Positive case | Required negative case |
|---|---|---|
| HTTP and Typert | User A invokes an allowed action in tenant A | Missing/expired token, forged tenant field, user B's resource id, direct lower-level Remote call |
| WebSocket | User A receives authorized baselines and later events | Tenant B create/event/workspace/approval never enters A's stream; revocation ends access |
| Persistence | A creates, resumes, forks, searches, exports, and deletes A's session | Known B id fails identically to unknown id on every operation and repair path |
| Workspace/settings | A reads and mutates permitted A scopes | User section cannot override enforced tenant policy; tenant B changes emit no A invalidation |
| Credentials | Authorized adapter uses a scoped credential without revealing it | Describe/use/manage distinctions hold; model process and another tenant cannot read value or source metadata |
| Attachments/spills | A's session stores, reads, forks, exports, and deletes references | Digest, locator, copied event, path traversal, and stale signed URL cannot cross tenant/session ownership |
| Approval/questions | Session owner answers one pending request | Other member, admin, stale tab, replayed rpc id, and revoked owner cannot answer |
| Execution | A accesses only its workspace and allowed network | Host files, tenant B volume, control files, ambient secrets, escaped child processes, and quota spillover are denied |
| Admin/audit | Authorized role changes membership and retrieves allowed audit facts | Tenant admin cannot become platform operator or read transcripts/secrets through management APIs |

Run a keyless end-to-end scenario with at least users A and B in tenant A, user C in tenant B, and one platform operator. Use valid ids from the other tenant rather than random absent ids so every test proves authorization rather than mere not-found handling. Exercise local and remote carriers, cold resume, fork, search, stream reconnect, pending interactions, attachment resolution, and cancellation.

Product-visible authentication, denial, administration, and session behavior requires real runnable snapshot coverage under the repository testing policy. Security tests additionally inspect server-side observations to prove forbidden handlers, persistence reads, event enqueue, vault resolution, and execution allocation were never reached.

## Data migration and rollback

The repository's pre-release stance permits rejecting old durable formats. Tenant ownership changes session headers, SQLite keys, JSONL roots, storage-domain state, settings, credentials, and attachment references, so an old store is never opened as though it belonged to the first authenticated caller.

The importer writes a new destination and leaves the source untouched. A manifest records source identity, target tenant, counts, content hashes, assigned ids, omitted records, and completion. Validation opens the destination through normal providers and compares every imported header/event/reference before traffic is switched. Rollback changes routing to the untouched source only while the deployment remains in local single-user mode; there is no rollback from multi-user writes into an ownership-free store.

## Decisions required before implementation

- Supported identity providers, token lifetimes, revocation bound, and CSRF strategy.
- Audit outbox, cross-runtime idempotency, reconciliation, and failure-reporting semantics.
- Tenant runtime granularity and scheduler: one process/container per tenant is the recommended first implementation.
- MySQL driver and topology, Redis and Elasticsearch providers, outbox delivery, secret-vault provider, backup objectives, regions, and retention requirements.
- Session privacy policy, administrative deletion authority, and whether any break-glass content access exists.
- Execution provider guarantees for process identity, network egress, secret delivery, teardown, storage cleanup, and cost quotas.
- Whether user and tenant settings share one schema per namespace or require separate policy/preference declarations.
