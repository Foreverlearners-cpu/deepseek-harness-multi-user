# Multi-user data and runtime isolation

English | [中文](data-and-runtime-isolation.zh.md)

This reference defines proposed ownership and isolation rules for durable data, live state, event delivery, credentials, and model-controlled execution. Identity and policy decisions come from [identity and access](identity-and-access.md).

## Ownership model

Every resource has an immutable tenant owner at creation. Resources that represent one principal's work also have a discriminated owner principal. Mutable grants and lifecycle state live in control-plane tables rather than being copied into every record.

| Resource | Required ownership | Required change |
|---|---|---|
| Session header | `tenantId`, `ownerPrincipal: SessionOwner`, `workspaceId?` | Stamp from authenticated context; never trust these fields from a create request |
| Session events | Session foreign key and optional human actor attribution | Keep replay data under the owning header; do not duplicate tenant selection in model-authored payloads |
| Workspace | `tenantId` and an execution-volume binding | Replace arbitrary shared Host paths with an authorized workspace id in server mode |
| Settings | Deployment, tenant, and user scope | Resolve explicit layers and persist each layer independently |
| Credentials | Tenant or user scope plus grants | Resolve through a vault provider; never expose values or storage paths to the execution world |
| Attachments and spills | Tenant and session reference | Authorize every read through an owning session; namespace temporary and durable objects |
| Live agents, terminals, jobs, approvals, questions, and workflow runs | Tenant and session owner | Key registries and notifications by authenticated runtime/session ownership |
| Projections, titles, search indexes, caches, and telemetry | Tenant plus source resource | Include tenant in every key, query, invalidation, export, and retention operation |

Opaque ids remain globally collision-resistant UUIDs or equivalent random identifiers, but unguessability is not authorization. Storage and service methods use scoped keys such as `(tenantId, sessionId)` even when `sessionId` is globally unique. Process-local `session-<n>` minting is not suitable for a persistent multi-user deployment.

## Session persistence

`SessionHeader` is the correct owner for immutable session tenancy because it already carries out-of-log storage metadata used by every persistence backend. The proposed header adds branded `tenantId`, discriminated `ownerPrincipal`, and an optional `workspaceId`. Server-mode creation derives them from the tenant variant of `AuthenticatedCall`; import is the only path that may supply validated historical ownership.

The persistence seam becomes tenant-scoped at its public and backend interfaces. `create`, `prepare`, `load`, `inspect`, `readFrom`, `list`, `listSnapshots`, `fork`, repair, and collision checks all receive or derive an access scope. No method scans every tenant and filters afterward. A system maintenance interface may enumerate tenants, but it is a separate control-plane capability unavailable through ordinary Remote descriptors.

SQLite uses composite ownership and foreign keys:

```text
sessions  PRIMARY KEY (tenant_id, id)
events    PRIMARY KEY (tenant_id, session_id, seq)
events    FOREIGN KEY (tenant_id, session_id) REFERENCES sessions
```

Every index used by list, lineage, title, content search, usage, or retention begins with `tenant_id`. Production deployments use MySQL through the proposed `dsh-mysql` infrastructure service for multi-process concurrency, backup, point-in-time recovery, and operational scaling. MySQL has no PostgreSQL-style row-level security, so application services and relational constraints always enforce tenant-scoped access; a dedicated database per tenant or tenant group may add a stronger physical boundary. SQLite remains a single-node provider and uses the same tenant-aware query rules so development does not exercise weaker ownership contracts.

JSONL remains a local or explicitly single-tenant backend. If retained for a server-mode import/export tool, its root is already selected by the tenant runtime and its physical layout includes an encoded tenant directory before project/session directories. It never uses a user-supplied Host `cwd` to escape or select a tenant root. Cross-tenant artifact discovery is absent rather than filtered.

Fork requires source read and child create authority, retains the same tenant, and defaults the child owner to the caller only when policy allows reading the full source. Cross-tenant movement is export/import: it copies permitted event and attachment data, assigns new ids and ownership, strips runtime-only references, and records both sides in the audit system.

## Session log and security audit

The session event log and security audit log serve different readers and must remain separate.

| Log | Purpose | Content rule | Reader |
|---|---|---|---|
| Session event log | Reconstruct model-visible state, resume, replay, fork, UI projections | Model/user/tool facts needed for behavior; no auth tokens or general access decisions | Authorized session consumers and the agent runtime |
| Security audit log | Explain who attempted or changed protected state | Actor, tenant, action, resource type/id, decision, outcome, request id, time, reason code, bounded transport metadata | Tenant audit roles and platform security operators under separate policy |
| Operational log | Diagnose service health and failures | Request id, opaque resource ids, component, safe error and timing; no message/tool/secret bodies by default | Deployment operators |

Human-authored session mutations carry actor provenance when more than one actor can affect a session. In the first private-session release, ownership plus the authenticated request audit is sufficient for ordinary user messages; collaboration work must add durable actor attribution before it permits shared writes. Provider responses and model-authored tool calls remain attributed to the session execution, not to a fabricated human actor.

Audit writes occur in the control plane and are append-only to product services. A control-plane mutation commits business state and an audit outbox entry in one database transaction. For a tenant-runtime mutation, the control plane durably records the authorized attempt before dispatch, the runtime deduplicates execution by `requestId`, and outcome delivery is retryable and reconcilable. A committed mutation does not report success until its required outcome record is accepted; denied requests record a bounded denial event without reading protected content.

Audit data has explicit retention, export, legal-hold, and redaction policy. Hash chaining or WORM storage may be added for deployments that require tamper evidence, but ordinary append-only application tables must not claim that property.

Current session telemetry can contain prompts, messages, tool arguments/results, paths, and file content. A multi-user server defaults content telemetry to disabled. Enabling it requires tenant policy, user disclosure, a reviewed redaction pipeline, destination allowlisting, regional/retention controls, and audit of policy changes. Anonymous Harness-home correlation ids are not account identity.

## Workspace and path model

The current workspace registry stores canonical Host paths and one global archive set. The tenant-aware registry stores its global state per `TenantId`, keys records by `(tenantId, workspaceId)`, and verifies every attached session has the same tenant and workspace binding.

Server clients choose `WorkspaceId`, never an arbitrary Host directory. An administrator or provisioning controller binds the workspace to a tenant volume, repository checkout, or remote sandbox template. The tenant runtime translates that binding into execution-world coordinates. Host paths do not cross the browser wire, enter a session log as user-selected authority, or become a cross-tenant directory key.

Local profiles retain path-based workspaces under the local principal. The two profiles share the business workspace interface only where semantics are honest; a server provider may omit native directory picking and Host `openPath` operations instead of emulating them.

## Settings and credentials

Settings resolution becomes an explicit layer stack: schema defaults, deployment base, tenant section, then user section. A namespace declares which scopes it permits. Tenant policy cannot be overridden by a user merely because the values share a schema; enforced policy and user preference are distinct inputs. Descriptors report source and revision without exposing another scope's raw document.

Writes address one authorized scope and carry its expected revision. Namespace events include the scope owner so another tenant's UI, cache, or runtime never observes the change. File-backed settings remain a local-profile provider. A server provider stores scoped sections in the control-plane database and publishes tenant-specific invalidations.

Credential references are scoped identities, not global environment-variable names. Resolution receives tenant/user scope and the operation's agent identity, then returns a secret only to the trusted provider adapter making the outbound request. Tenant-shared credentials require an explicit `credential:use` grant; manage authority is separate from use authority. User credentials never silently shadow or become visible to tenant peers.

The local `.credentials.yaml` and environment layers remain local-profile features. They are unsuitable for a shared server because same-UID model processes can read files and environment-name heuristics are not a secret boundary. Server mode uses a maintained vault or OS/cloud secret provider, does not materialize provider secrets into process-wide environment, and gives execution worlds short-lived task credentials only when a tool specifically requires them.

## Attachments, spills, and derived data

Content-addressed attachments need a tenant/session reference table even when identical bytes are deduplicated physically. Knowing an object digest or storage id never authorizes a read. A session upload commits the object and an ownership reference before the event that names it; history, provider resolution, export, fork, and garbage collection follow those references.

Cross-tenant physical deduplication is optional and must not leak existence through timing, quota, error, or metadata. Per-tenant encryption keys avoid shared ciphertext identity at the cost of deduplication. The first implementation should prefer simple tenant isolation over global deduplication.

Spills, subprocess output files, PTY state, LSP state, workflow workers, projection caches, title caches, prepared-session caches, search indexes, and temporary upload files all carry tenant/session scope. Cleanup operates within that scope and cannot enumerate or delete a broader root from an id supplied by a user.

## Event and live-state isolation

The current mux and Host streams broadcast all attached sessions, workspace changes, pending interactions, and some host events. The authenticated subscription instead snapshots only resources the principal may read and registers scoped listeners that cannot receive other tenants' events. Filtering after a frame enters a shared queue is too late because queue size, errors, and timing already disclose activity.

Every reconnect rebuilds its authorized baseline. Membership or resource-grant changes invalidate affected streams. Approval and question frames go only to an actor allowed to answer them; a second browser for the same actor may observe the same pending identity, while another user receives neither request nor resolution unless collaboration policy grants it.

Live maps use composite tenant/resource keys or reside inside one tenant runtime. Session lookup, resume deduplication, retirement chains, prepared caches, open tool-call tables, job visibility, and projection subscriptions must not use bare `SessionId` in shared infrastructure. Host-wide events are divided into public deployment facts, tenant-scoped facts, and platform-operator facts instead of forwarded verbatim to every client.

## Execution isolation

The shipped local filesystem sandbox restricts writes and permits reads. Local subprocesses, terminals, LSP servers, code workers, and workflow workers share Host authority; worker threads and `node:vm` are explicitly not security boundaries. These implementations cannot serve mutually untrusted tenants in one OS account.

A server session obtains an `ExecutionLease` from a container or microVM provider. The lease owns a tenant/session-scoped filesystem, process namespace, PTY/LSP processes, network policy, CPU/memory/process/time quotas, environment, and teardown. It carries immutable tenant, session, and generation identities; cold resume may allocate a new generation, but no lease attaches to another session and no live handle survives a generation change. Filesystem and subprocess capability providers route through the same lease so Bash, file tools, terminals, LSP, hooks, code, workflow children, and every subagent's execution-capability calls cannot drift into different worlds. Agent orchestration may remain in the tenant runtime, but it cannot open Host-local execution providers in server mode.

The execution world receives no control-plane database credential, identity-provider secret, tenant vault master credential, Host filesystem root, or ambient `DSH_*` value. It receives only explicit workspace mounts and short-lived capability credentials. Network egress is deny-by-default or policy-controlled, with destination and byte/time quotas. Teardown revokes credentials, terminates process trees, waits for quiescence, seals output, and releases the lease under an idempotent bounded operation.

The existing E2B providers demonstrate remote filesystem and subprocess replacement behind the correct seams, but their documented POC limitations remain. Production isolation requires a provider whose control channel, process identity, secret delivery, cleanup, and output retention meet this threat model; provider branding alone is not evidence of isolation.
