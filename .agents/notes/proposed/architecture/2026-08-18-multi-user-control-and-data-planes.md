# Agent Note: Multi-user control and data planes

Status: proposed

English | [中文](2026-08-18-multi-user-control-and-data-planes.zh.md)

## Problem

The shipped Web composition is a local single-user product. Its Host/Origin checks prevent browser rebinding but explicitly do not authenticate callers. Session, workspace, settings, credential, event-stream, and live-agent services assume one Harness home and one trusted operator. The local filesystem policy permits reads, while subprocesses, terminals, LSP servers, code workers, and workflow workers execute with the Host OS user's authority.

Adding login at the HTTP route would leave authorization undefined below the transport. A caller who knows a `SessionId` could still reach persistence, resume, fork, search, event delivery, attachments, pending approvals, or a lower-level Remote service unless every owner receives authenticated context. Adding a tenant filter only to durable stores would leave global live maps and all-session streams. Adding filters everywhere in one process would still place mutually untrusted model code under one Host account, where the current local providers are not a security boundary.

The product needs a foundation that supports several users without weakening local profiles, confusing the replay log with an audit ledger, or forcing collaborative sessions into the first release.

## Proposal

Split multi-user deployment into a control plane, tenant-scoped Harness runtimes, and session execution worlds. The detailed reference is [docs/multi-user](../../../../docs/multi-user/README.md).

The control plane owns authentication, internal user and tenant identities, memberships and roles, service accounts, policy decisions, administration, quotas, runtime routing, and an append-only security audit service. Browser authentication delegates to OIDC; automation uses scoped short-lived tokens. Local profiles synthesize an explicit local principal and personal tenant. Server profiles fail when no authentication provider is mounted and have no loopback or trusted-host authentication bypass.

Every protected transport call becomes an immutable `AuthenticatedCall` before API Proxy or Typert dispatch. It carries a request id, principal, authentication method, cancellation signal, and a discriminated tenant or platform scope. Tenant scope contains an active tenant and membership; platform scope is accepted only by control-plane management methods. Protected service methods receive this context explicitly. A request payload cannot establish its own actor or tenant, and in-process carriers use the same call path.

Policy and resource ownership are both required. The policy service decides actions such as session read, steer, approve, export, workspace manage, credential use/manage, and membership manage. The resource owner performs a tenant-scoped lookup and verifies session/principal ownership before content, existence, counts, or events leave the service. Cross-tenant valid ids have the same external not-found result as absent ids.

Session headers gain immutable tenant and discriminated owner-principal identities stamped by the session factory. A session may be owned by a human user or service account. Persistence, query, workspace, settings, credentials, attachment references, projections, search, caches, event subscriptions, approvals, jobs, terminals, and live-agent registries become tenant-scoped. Session ids remain opaque collision-resistant identifiers, but no component treats unguessability as authorization. The existing ownership-free durable formats reject; a separate one-shot importer writes a new tenant-owned store.

MySQL is the authoritative server relational store through the proposed `dsh-mysql` infrastructure service. `dsh-mysql` owns named pools, transactions, migration coordination, health, and classified failures; identity, session persistence, settings, audit, and other domain Consumers own their tables and queries. Redis carries disposable cache and coordination state, while Elasticsearch carries rebuildable search projections. A transactional MySQL outbox drives both so neither system becomes an authorization or replay authority.

The session event log remains the replay source for model-visible behavior. Security audit records use a separate store and contain actor, tenant, action, resource identity, decision, outcome, request id, time, and bounded metadata without authentication tokens, credential values, or message/tool bodies. Human actor attribution joins the session log only when a human-authored fact must be reconstructed for shared-session behavior.

The first release keeps sessions private to their owner principal. Tenant roles manage membership, workspace policy, retention, suspension, and other explicit administrative actions; they do not imply transcript reading or execution approval. Service-account-owned sessions cannot use a service identity as a human approval response. Collaborative read/write/approve grants and concurrent turn ownership are deferred.

A tenant runtime owns one plugin composition and tenant-scoped providers. The first server deployment uses one process or container per tenant; pooling several runtime instances is allowed only after every in-memory registry, cache, listener, and provider client is partitioned. This runtime boundary limits a missed application filter but does not replace resource authorization.

Each model-controlled session obtains an isolated execution lease from a container or microVM provider. Filesystem, subprocess, shell, PTY, LSP, code, workflow, hooks, jobs, and subagent execution route through the same lease. Local providers and worker-thread/`node:vm` engines remain available to trusted local profiles and are rejected by server-composition invariants. The execution world receives authorized workspace mounts and short-lived task credentials, never Host roots or control-plane secrets.

## Alternatives considered

**Add `userId` or `tenantId` to every RPC payload.** Rejected because the caller would be asserting the fact that authorizes it. Trusted tenancy comes from authentication plus membership and must reach resource owners outside the wire DTO.

**Authenticate at Connection and leave business services unchanged.** Rejected because API Proxy, Typert Remote methods, persistence preparation, streams, and in-process callers have independent paths to protected resources. A transport-only check cannot constrain those paths.

**Run every tenant in one shared Cordis context with filtered stores.** Rejected for the first implementation because live maps, reconnect baselines, event queues, caches, temporary files, and provider services also require partitioning, while local execution still shares Host authority. A later pool may host separate tenant runtime instances after the same contracts are proven.

**Run one complete Harness process per user and stop there.** This is secure for private users but makes organization policy, tenant credentials, shared workspaces, administration, and aggregate quotas an external collection of unrelated homes. One runtime per tenant preserves a clear administrative unit while sessions remain user-private.

**Use the session event log as the security audit log.** Rejected because the session log exists to reconstruct model-visible behavior and is copied by fork/replay. Authentication failures, role changes, secret administration, and operator actions have different readers, retention, and redaction rules and must not enter model history.

**Let every domain plugin open its own MySQL pool.** Rejected because connection lifecycle, bootstrap secrets, timeouts, migration locking, failure classification, observability, and shutdown would diverge across identity, session, settings, and audit implementations. One Host-only infrastructure service owns those mechanics while domain services retain data ownership.

**Expose MySQL only as the existing KV storage backend.** Rejected because the KV form deliberately lacks cross-table transactions, secondary indexes, and multi-segment keys. It remains useful through an optional adapter, but authentication and session persistence use dedicated domain Consumers over `dsh-mysql`.

**Build password authentication into the Harness.** Rejected because a maintained OIDC provider owns password storage, MFA, recovery, federation, and compromise response. The Harness consumes verified identity and owns product authorization.

**Treat `workspace-write`, worker threads, or E2B branding as sufficient tenant isolation.** Rejected because the local file policy permits reads, worker threads and `node:vm` share process authority, and the current E2B packages document control-channel and same-UID limitations. Server composition requires provider guarantees that satisfy the execution threat model.

## Acceptance criteria

- Server HTTP, WebSocket, SDK, ACP, in-process, and Typert paths produce the same authenticated call context and deny missing, expired, revoked, or wrong-audience credentials.
- Every durable and live resource has one tenant owner; session work has one owner principal; all list, search, count, resume, fork, export, stream, attachment, approval, and mutation paths enforce those owners before disclosure.
- Valid cross-tenant ids return no resource data and trigger no persistence read beyond the scoped index, event enqueue, vault resolution, agent resume, or execution allocation.
- Tenant A and tenant B can run concurrently without receiving one another's events, pending interactions, workspace changes, cache entries, temporary artifacts, telemetry content, or execution effects.
- Server model execution cannot read Host configuration, control-plane credentials, another tenant's storage, or another session's execution state, and teardown reaches bounded quiescence.
- Session replay remains lossless and model-visible input remains logged; authentication and security-audit data do not enter model history.
- Local Web, headless, and automation profiles continue through an explicit local principal without mounting server-only control-plane dependencies.
- Keyless assembled tests use real valid ids across at least two tenants and cover HTTP, streams, persistence, cold resume, fork, search, attachments, approvals, execution, revocation, and administration.

## Risks

- A control-plane/data-plane split introduces routing, lifecycle, versioning, and operational failure modes. Signed forwarding assertions, runtime health, retries, and request/audit idempotency need explicit contracts before horizontal scaling.
- One runtime per tenant can consume substantial memory and startup time. Pooling is a later optimization, but pressure to pool early could recreate shared-state leakage before partitioning is proven.
- Authorization context added to many service methods may encourage wrappers or duplicate checks. Each resource must retain one scoped owner API, with adapters projecting into it instead of creating unprotected siblings.
- MySQL, Redis, Elasticsearch, a vault, and a container provider add production dependencies and cross-system recovery cost. Keeping SQLite, file credentials, and local execution in the local profile prevents those costs from leaking into trusted single-user use.
- Administrative support requests may create pressure for implicit transcript access. The role model must keep operational control separate from tenant content access, with any future break-glass path explicit and audited.
- Import spans session logs, workspace accounts, settings, credentials, attachments, and derived indexes. A partial or implicit migration could assign data to the wrong tenant, so import writes a separate destination and validates it before routing changes.
