# Agent Note: Decoupled delivery of the MySQL multi-user plugin suite

Status: proposed

English | [中文](2026-08-23-decoupled-mysql-plugin-delivery.zh.md)

## Problem

The candidate MySQL multi-user implementation combines five new packages, several independently loadable Cordis entry points, changes to thirteen packages that already exist on the upstream branch, root build metadata, generated references, deployment composition, and migration scripts in one shared topic-branch commit. The combined change has three delivery defects.

First, development happened directly on the shared `mysql` branch. Corrective work on that branch would mix review history further, while rewriting the branch would invalidate collaborators' local history.

Second, one commit and one branch carry several plugins with different responsibilities and dependency directions. Reviewers cannot approve, test, merge, revert, or release one plugin independently.

Third, the candidate implementation changes existing DSH packages so that the new plugins compile and integrate. This reverses the intended dependency direction: an optional plugin requires a locally patched DSH distribution instead of consuming documented services, events, routes, slots, and configuration layers from an unmodified distribution.

The replacement must preserve the useful outcomes—MySQL session persistence, semantic conversation projection, user ownership, file storage, optional HTTP and UI integration, and optional checkpoint or outbox behavior—without preserving the coupled implementation.

## Proposal

Treat the existing `mysql` branch as shared history and restore its content through a normal revert PR. Build every replacement from the latest upstream `master`, with one independently loadable or publishable unit per branch and one final logical commit per branch. A plugin branch may change its own package, its own tests and documentation, and narrowly required repository registration metadata; it must not change another existing or proposed plugin.

The five package directories introduced by the candidate implementation are source material, not commits to reuse. Implementers may inspect or extract a package-owned file from the candidate commit, but they must not cherry-pick the complete commit. Every extracted file is reviewed against current `master`, stripped of dependencies on patched DSH packages, and validated within its own branch scope.

Any effect that previously required editing an existing Host, client, persistence, title, checkpoint, bundle, or catalog package becomes one of three things: an independent companion plugin using a documented extension point, deployment configuration owned by the adopter, or a deferred capability when no public extension point exists. A MySQL plugin never introduces an undeclared patch to an existing DSH package.

## Delivery invariants

- The shared `mysql` branch is never force-pushed or rebased after publication.
- Every corrective or implementation change starts on a new branch.
- Every plugin branch contains one independently loadable or publishable unit and ends as one logical commit.
- A plugin imports only current upstream packages and prerequisite plugin contracts that have already merged or are the declared base of a temporary stacked PR.
- No package under `packages/core`, no default bundle, and no existing plugin changes merely to make an optional MySQL plugin work.
- Installing no MySQL plugins leaves the upstream build, runtime composition, public types, routes, UI, and persistence behavior unchanged.
- When a required extension point is absent, the feature is deferred or proposed upstream separately; the plugin does not create a private fork of the consumer.
- Every branch carries the package-owned English and Chinese documentation, tests, invariants, and the narrow verification evidence required by its diff.

## Package topology

| Proposed branch | Proposed package or unit | Responsibility | Prerequisites |
|---|---|---|---|
| `plugin/user-service` | `packages/identity/user` | Service Definition for user identity and lookup; no MySQL implementation | Current `master` |
| `plugin/user-mysql` | `packages/identity/user-mysql` | MySQL Service Provider for the user service | Merged `user-service`; upstream MySQL service |
| `plugin/file-storage` | `packages/storage/file-storage` | Provider-neutral file-object contract and local content-addressed provider when one lifecycle owns both roles | Current `master` |
| `plugin/session-persistence-mysql` | `packages/session/session-persistence-mysql` | MySQL implementation of the existing `SessionPersistence` service | Upstream session-persistence and MySQL services; merged user contract only if identity is required |
| `plugin/conversation-persistence-mysql` | `packages/session/conversation-persistence-mysql` | Semantic conversation, message, attempt, file-metadata, and outbox projection | Merged user and file-storage contracts; upstream MySQL service |
| `plugin/runtime-config-mysql` | New standalone package if retained | Runtime configuration storage with its own service and lifecycle | Upstream MySQL service |
| `plugin/conversation-outbox-consumer` | New standalone package if retained | Optional Kafka, Redis, or Elasticsearch delivery of committed outbox rows | Merged conversation persistence contract and selected upstream providers |
| `plugin/conversation-file-api` | New Host companion package | File upload and download routes registered through `ctx.webServer` | Merged conversation and file-storage contracts; upstream webserver service |
| `plugin/storage-status-ui` | New client companion package | Storage status card registered in the existing settings slot | Published client-facing status source and upstream client slots |
| `plugin/session-checkpoint-time` | New policy package if retained | Optional elapsed-time checkpoints using existing session events and persistence operations | Upstream session and persistence services |

The main conversation package owns only its primary Cordis plugin. The existing `session-persistence`, `runtime-configs`, and `outbox-consumer` subpath entry points do not remain hidden secondary plugins in that package. A helper that has no independent configuration, injection list, lifecycle, or loader entry may remain internal; an independently activatable entry point is a separate plugin and therefore a separate branch.

## Compatibility design

### Session ownership

The plugin does not add `userId` to `SessionHeader`, `CreateSessionOptions`, `CreateAgentOptions`, or the agent loop. The persistence provider keeps ownership in its own schema and applies the authenticated or configured principal to every storage operation.

```sql
CREATE TABLE session_owners (
  session_id VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL
);

SELECT ...
FROM sessions
WHERE session_id = ? AND user_id = ?;
```

For a deployment that assigns one configured user to one DSH Host, the provider resolves that user during activation and records it when a session is first persisted. A deployment that serves several authenticated users concurrently requires a documented request-scoped identity mechanism. If current DSH has no such mechanism, concurrent multi-user serving remains outside this proposal rather than being simulated with global mutable state or a core patch.

### Session persistence and resume

`session-persistence-mysql` implements the upstream `SessionPersistence` contract, including create, append, load, list, and preparation behavior. Existing DSH consumers continue to use `ctx.sessionPersistence`; they do not probe a MySQL-specific service or special-case a semantic conversation store. The provider persists the event information required by upstream validation, replay, resume, fork, transcript, and UI fidelity.

The semantic conversation store is a projection, not a replacement for the canonical session event log. It may hydrate its own API responses, but it does not silently redirect `api/remotes` or another existing consumer. If a product requires a new semantic-resume contract, that contract is proposed as an independent capability with a Service Definition, Service Provider, and Consumer.

### Transactions

MySQL plugins use the existing connection callback and own their transaction sequence inside that callback. They do not add a convenience method to the upstream MySQL plugin. Callback failure, commit failure, and disposal must leave the leased connection in the state required by the upstream connection contract; integration tests pin commit, rollback, and retry behavior.

### HTTP and client integration

File transport belongs to `conversation-file-api`, which registers and disposes its own exact routes through the upstream webserver service. It does not add methods, schemas, configuration, or handlers to `host/apiproxy`. Authentication and ownership checks occur before file metadata or bytes leave the service.

Storage presentation belongs to `storage-status-ui`, which registers its own component in the existing settings slot. It does not add components, locale keys, fixtures, or tests to `ui-settings-general` or change the client slot catalog by hand. If the client cannot obtain a safe storage-status snapshot through a public source, the card is deferred until that source exists.

### Composition, checkpoints, titles, and catalogs

The default Web bundle remains unchanged. Adopters enable providers and disable the default JSONL row through their profile or `cordis.patch.yml`; package documentation owns a complete example and lists the required environment variables without embedding credentials.

The existing checkpoint and session-title plugins remain unchanged. Elapsed-time checkpointing is an independent event consumer if the public session and persistence operations are sufficient. Runtime title mutation is deferred unless the title service exposes a supported configuration operation. Service and module catalogs are regenerated only from authoritative package metadata or source; plugin branches do not hand-edit generated entries to advertise unmerged services.

## Existing packages that remain unchanged

| Existing package | Candidate modification to remove | Replacement |
|---|---|---|
| `packages/core/session` | User identity fields and dependency on the user package | Plugin-owned ownership tables and checks |
| `packages/core/agent` | User identity in agent creation metadata | Identity resolved by the provider at its supported boundary |
| `packages/core/agent-loop` | Session creation changes for user metadata | No replacement; the upstream loop remains the consumer of the upstream session contract |
| `packages/api/remotes` | MySQL conversation lookup before standard persistence | Full implementation of the existing `SessionPersistence` contract |
| `packages/bundle/web-app` | MySQL packages, environment config, and provider selection in the default bundle | Adopter-owned profile or patch example |
| `packages/client/connection` | New file transport methods in an existing fixture | Companion client package and its own fixtures, if required |
| `packages/client/ui-settings-general` | Storage status component and locale additions | Independent settings-slot plugin |
| `packages/extensions/cordis-client-runner` | Manual registration of the storage-status component | Registration owned by the new client plugin |
| `packages/extensions/tool-cordis` | Hand-written entries for new services | Package-owned public documentation and ordinary catalog generation after merge |
| `packages/host/apiproxy` | Conversation list, storage status, identity config, and file routes | Standard persistence plus an independent webserver route plugin |
| `packages/multi/mysql` | New transaction convenience API | Transaction sequence owned by each new provider |
| `packages/session/session-checkpoint-policy` | Timer scheduler and strategy registry | Independent checkpoint plugin or the upstream behavior unchanged |
| `packages/session/session-title` | Runtime-config injection and mutable limits | Startup config or a future supported adapter; otherwise deferred |

Root metadata is not an exception to package isolation. A branch may update one aggregate TypeScript project registration when repository rules require it, one package manifest or workspace declaration when automatic discovery is insufficient, and the lockfile entries caused by that package's declared dependencies. Unrelated generated churn, scripts for another plugin, and catalog changes for unmerged packages are excluded.

## Branch and merge workflow

1. Fetch the remote and create the plugin branch from the current verified `origin/master`, or from a prerequisite plugin branch only while its PR is the declared temporary base.
2. Inspect candidate files with path-specific Git commands; never cherry-pick the coupled commit.
3. Add only the current package and its owned documentation, tests, invariant, and required registration metadata.
4. Replace imports or runtime probes that rely on another unmerged package or a patched DSH consumer with the declared public contract.
5. Run `pnpm --silent run change-scope --base <verified-base-ref>` and inspect every committed, staged, unstaged, and untracked path.
6. Run the narrow package tests and build checks selected for the changed behavior, followed by the documentation gates for documentation changes.
7. Squash development commits so the branch ends with one complete logical commit; push normally and open a PR against its verified base.
8. Merge prerequisites before dependents. Rebase a temporary stacked dependent onto updated `master`, revalidate its complete scope, and publish with lease protection only when history rewriting is necessary and authorized.

The intended merge order is:

```text
user-service ──> user-mysql
       │
       ├────────> session-persistence-mysql
       └────────> conversation-persistence-mysql ──> conversation-outbox-consumer
file-storage ──────────────────────────────────────> conversation-persistence-mysql
conversation-persistence-mysql + file-storage ────> conversation-file-api
published status source ───────────────────────────> storage-status-ui
upstream session + persistence ───────────────────> session-checkpoint-time
```

A temporary stacked PR sets its base to the prerequisite branch so its visible diff contains only the dependent plugin. After the prerequisite merges, the dependent branch moves to current `master`; a PR is not ready while its diff against the live base includes a prerequisite plugin.

## Diff policy

Each plugin PR defines an explicit path allowlist before implementation. The allowlist normally contains the package directory, its paired Agent Note or package documentation, exactly one aggregate TypeScript registration when required, and dependency-only lockfile changes. Any changed path outside that list stops the push until it is removed or separately justified as a new plugin branch.

The scope review rejects these patterns unless the branch itself owns a new package at that exact path:

```text
packages/core/**
packages/bundle/web-app/**
packages/host/apiproxy/**
packages/client/ui-settings-general/**
packages/extensions/tool-cordis/**
packages/extensions/cordis-client-runner/**
packages/multi/mysql/**
packages/session/session-checkpoint-policy/**
packages/session/session-title/**
```

The untracked generated cache directory `Usersxishuai.npm-cache/` is never staged, committed, used as package source, or treated as verification evidence.

## Verification

| Requirement | Evidence before merge |
|---|---|
| Branch isolation | `change-scope` and `git diff --name-only <base>...HEAD` contain only allowlisted paths |
| Upstream compatibility | Clean upstream composition builds and starts without any MySQL plugin installed |
| Plugin activation | The target plugin builds, activates with declared prerequisites, and fails clearly when a required service is absent |
| Persistence behavior | Focused tests cover create, append, flush, list, load, resume, ordering, cancellation, and corrupt or partial data behavior owned by the provider |
| Transaction safety | MySQL integration tests cover commit, callback failure, rollback failure, retry, and disposal |
| Tenant isolation | Tests prove user A cannot list, load, update, delete, or read files owned by user B |
| Migration safety | Schema creation is idempotent; upgrades preserve committed data; destructive migration requires a separately reviewed procedure |
| Lifecycle safety | Plugin unload disposes listeners, routes, timers, subscriptions, leases, and background work without stale registrations |
| Optional integrations | HTTP, UI, checkpoint, runtime-config, and outbox tests live in their owning plugin branches |
| Documentation | English and Chinese package docs and Agent Notes are paired; `pnpm run doc-sync`, `pnpm run lint`, and `git diff --check` pass |
| Remote publication | The remote branch OID matches local `HEAD`; shared branches receive ordinary PR merges, never raw force pushes |

Full-repository tests remain CI's responsibility unless a plugin changes a genuinely repository-wide contract. A branch does not claim readiness from a successful push alone; its selected local evidence and required remote checks must pass.

## Documentation deliverables

Every package branch documents configuration, service dependencies, activation order, persistence or wire semantics, failure behavior, security and ownership rules, limitations, extension points, model-visible effects, and disable or rollback instructions in its own English and Chinese README pair. The same branch adds or updates the Agent Note that owns its non-trivial decision and records the translation pairing sidecars.

Generated architecture, module, service, config, and persistence catalogs change only through their owning generators after the source package merges. A final docs-only integration branch may describe how the independently merged plugins compose, but it contains no plugin source and does not replace the package READMEs as the contract owners.

## Shared branch rollback

Because `mysql` is shared, its published history is preserved. A rollback branch created from the live `mysql` head reverts the coupled commit and opens an ordinary PR back to `mysql`. The rollback commit may reverse many paths because it atomically removes one coupled change; this is a history-repair operation, not a model for future feature branches.

The rollback is verified by comparing its resulting tree to the commit immediately before the coupled change. The shared branch content returns to that tree only after review and merge. The candidate commit remains reachable in history for selective inspection, while no replacement branch uses it as a base.

After independent plugins merge, each plugin can be disabled through composition and reverted through its own PR. Database migrations are additive by default; disabling a plugin does not drop data, and destructive cleanup is a separate explicitly authorized operation.

## Alternatives considered

**Keep the coupled commit and clean it incrementally.** Rejected because every intermediate state continues to mix package ownership, and reviewers cannot prove that an apparent plugin diff has stopped depending on patched DSH packages.

**Reset and force-push the shared `mysql` branch.** Rejected because collaborators may have fetched or based work on the published commit. A normal revert preserves object reachability and lets the team review the content restoration.

**Move user identity into core session and agent types.** Rejected because optional persistence would impose its identity model on every DSH deployment and make core packages depend on an optional plugin contract.

**Keep all plugins on separate commits in one long-lived branch.** Rejected because PR, release, and revert scope would still include every earlier plugin, while dependents could quietly rely on sibling implementation details.

**Duplicate service interfaces inside every consumer so all branches compile from the same base.** Rejected because structurally similar local types do not create one owned capability contract and can drift at runtime. Shared contracts merge first or become explicit temporary stack bases.

**Patch an existing consumer when no extension point exists.** Rejected for this plugin suite. The capability is deferred or proposed upstream as a generic extension point with its own review and compatibility obligation.

## Acceptance criteria

- The shared `mysql` branch returns to the tree before the coupled change through a reviewed revert PR without history rewriting.
- Every retained independently activatable entry point has its own package or unit, branch, PR, and final logical commit.
- Every replacement branch starts from current `master` or declares a temporary prerequisite branch as its PR base.
- No replacement PR changes any of the existing package paths listed in this note.
- Core session, agent, and agent-loop public types contain no MySQL-suite user identity fields or dependencies.
- `session-persistence-mysql` satisfies the existing `SessionPersistence` behavior without MySQL-specific consumer probes.
- User ownership is enforced in plugin-owned storage and is covered by cross-user denial tests.
- File routes and storage UI, when retained, are delivered as independent plugins through documented webserver and client-slot extension points.
- Runtime config, outbox consumption, and elapsed-time checkpointing, when retained, have independent ownership and lifecycle.
- Installing no replacement plugin leaves the upstream build and default runtime behavior unchanged.
- Every plugin branch passes its scoped behavior checks, documentation gates, diff allowlist review, and required remote CI.
- Package READMEs and the final integration guide describe installation, ordering, configuration, limitations, and rollback without requiring edits to an upstream package.

## Risks

Sequential merging can slow dependent plugins, but it keeps each diff reviewable and makes the dependency graph explicit. Temporary stacked PRs reduce idle time only when their bases and post-merge rebases remain visible.

The upstream extension points may not support every candidate UI or runtime-config effect. This proposal deliberately gives up those effects until a generic extension exists rather than shipping a private compatibility fork.

User ownership is only as strong as the identity source supplied to the provider. A globally configured user preserves a single-user-per-Host deployment but does not claim concurrent request-level isolation; a true shared Host requires an authenticated request-scoped identity contract.

Separating plugins creates more branches, releases, and version constraints. Ordered merges, explicit peer or workspace dependencies, package-owned compatibility statements, and one final integration guide contain that operational cost.

Schema mistakes can outlive a plugin rollback. Migrations therefore remain additive and idempotent by default, tenant predicates receive integration coverage, and destructive cleanup never runs as an implicit uninstall step.
