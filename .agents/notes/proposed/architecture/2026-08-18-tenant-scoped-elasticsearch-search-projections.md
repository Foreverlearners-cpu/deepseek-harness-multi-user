# Agent Note: Tenant-scoped Elasticsearch search projections

Status: proposed

English | [中文](2026-08-18-tenant-scoped-elasticsearch-search-projections.zh.md)

## Problem

Multi-user search and analytical projections need Elasticsearch without making it authoritative for identity, authorization, or durable product state. The existing Host-only connection service owns one client and its lifecycle, but it does not define how several Consumer domains select credentials, construct tenant-scoped requests, deliver source changes, or rebuild projections.

An unrestricted cluster client cannot enforce domain authorization. A query that omits its tenant predicate can leak document existence, counts, scores, aggregations, timing, and resource use even when the caller filters returned hits. Projection delivery must also tolerate duplicate and reordered work without replacing newer source state or resurrecting deleted records.

## Proposal

Evolve [`@deepseek-ai/dsh-elasticsearch`](../../../../packages/multi/elasticsearch/README.md) only as concrete search-domain Consumers require shared connection behavior. The infrastructure service owns client construction, named connection lifecycles, endpoint security, transport policy, classified transport failures, health, and bounded client-level observability. Each domain Consumer owns index names, mappings, document schemas, authorization, query construction, retention, outbox consumption, and rebuild orchestration.

Elasticsearch remains an eventually consistent, rebuildable projection. MySQL is authoritative for relational mutations and outbox records, while an owning durable event log remains authoritative for event-sourced data and model replay. Authorization, membership, revocation, durable mutation acknowledgement, and audit authority never depend on Elasticsearch contents or availability.

The service remains available only to trusted Host plugins. Typert, API Proxy, tools, model execution, containers, and microVMs do not receive cluster clients or bootstrap credentials.

## Service model

The service provides explicitly named Elasticsearch bindings. Each binding owns one official Elasticsearch client and one cluster target so control-plane, indexing, and search compositions can use separate credentials or deployments without changing domain code. Binding ids use a branded `ElasticsearchBindingId` at package boundaries.

```text
ctx.elasticsearch
  binding(bindingId: ElasticsearchBindingId) -> ElasticsearchBinding

ElasticsearchBinding
  operation(options, callback)
  health(signal)
```

`operation` admits work only while the binding is running and passes a borrowed official-client API to the callback for that callback's lifetime. The API preserves official request overloads while excluding direct client lifecycle controls, transport properties, and client metadata. Callers may return materialized response values, but they must not retain the client; they must await client-backed requests and fully consume or close client-backed streams and async iterators before the callback result settles. Official response and error metadata can still carry connection objects, which callers treat as read-only diagnostics.

Each Consumer selects a validated binding through Cordis plugin configuration. Missing or duplicate bindings fail plugin activation. Binding selection remains explicit at the package boundary; no process-global default silently redirects a Consumer to another cluster.

The binding stops new admission during disposal, waits for active callbacks within a configured shutdown bound, records operations that exceed it without request bodies or protected content, and closes the client before disposal completes.

## Configuration and bootstrap

Deployment-varying values use validated Cordis plugin configuration.

| Configuration area | Required behavior |
|---|---|
| Endpoint | Resolve one unambiguous node or maintained discovery configuration; permit an explicit proxy path and reject credentials, queries, fragments, incomplete URLs, and unsupported protocols |
| Bootstrap identity | Accept an explicitly selected maintained client authentication method, reject unknown or conflicting fields, and keep credentials outside MySQL and Elasticsearch documents |
| TLS | Verify server identity for server profiles; accept complete trust inputs, while plaintext or disabled verification is restricted to an explicit trusted-local profile |
| Transport | Configure request-timeout and retry defaults, connection timeout, retry-on-timeout behavior, and shutdown bound; define which values a Consumer may override per request |
| Compatibility | Validate the supported Elasticsearch product and version range during startup |
| Observability | Configure bounded operation names and telemetry hooks without enabling request-body logging |

Elasticsearch credentials are bootstrap secrets supplied by the orchestrator or a maintained secret service. Diagnostics and resolved configuration never expose passwords, API keys, bearer tokens, client private keys, signed request headers, or credential-bearing URLs.

Production credentials receive only the cluster and index privileges required by their Consumer composition. Index-template administration, rebuild jobs, runtime indexing, and runtime search can use separate bindings and credentials. A trusted-local profile may combine roles only when its configuration explicitly accepts weaker operational isolation.

## Operations and failure semantics

- The binding uses the maintained official Elasticsearch JavaScript client and does not wrap its query DSL or response fields in a generic search abstraction.
- Cancellation reaches client requests where the client supports an abort signal. If cancellation races an indexing request, the Consumer treats the write outcome as unknown until source-revision reconciliation proves the indexed state.
- The service classifies authentication, authorization, product or version mismatch, timeout, cancellation, unavailable-node, rejected-execution, malformed-response, and transport failures without including request bodies or protected document content.
- The service does not retry arbitrary Consumer callbacks. The configured client transport may retry requests only under documented client rules; a Consumer makes projection writes idempotent before permitting retries.
- A successful indexing response does not make Elasticsearch authoritative. The source record and committed outbox entry remain the basis for reconciliation and rebuild.
- Search failure never falls back to an unscoped query or a stale result from another tenant. A Consumer returns an explicit unavailable or stale status according to its product behavior.

Operation names used for metrics and logs are bounded identifiers declared by Consumers. Logs and metrics exclude query bodies, document bodies, hit content, authentication material, unbounded resource ids, and tenant-provided index fragments.

## Index and document ownership

The infrastructure service owns no product index, alias, template, mapping, ingest pipeline, lifecycle policy, or document schema. Each search-domain Consumer owns a unique namespace and defines the complete projection from its authoritative source into Elasticsearch documents.

Index names and aliases come from validated deployment and domain configuration, never directly from request fields. Consumers treat aliases as operational routing conveniences rather than authorization controls. A request cannot choose an arbitrary index, alias, script, stored query, field name, sort expression, or aggregation path unless the owning domain validates it against an explicit allowlist.

Shard count, replicas, rollover, retention, and shared-index versus index-per-tenant topology remain decisions for the first measured search domain rather than package defaults.

## Tenant isolation

Every tenant-owned document carries an immutable `tenant_id` derived from authenticated authority and authoritative source ownership. Request payloads cannot establish or override that value.

The search-domain Consumer constructs a tenant-scoped request before calling Elasticsearch. The tenant predicate is present in the request sent to Elasticsearch; post-query filtering is forbidden.

A shared index requires a mandatory exact-match tenant filter on every search, count, update-by-query, delete-by-query, aggregation, and document-lookup path. Index-per-tenant deployments reduce the effect of a missed filter but increase shard, template, rollover, and rebuild cost; they still require trusted tenant-to-index routing.

Control-plane and tenant-runtime processes use separate least-privilege Elasticsearch identities. The client library, network route, credentials, and `ctx.elasticsearch` service remain outside every model-controlled execution environment.

## Projection consistency

A domain mutation commits its authoritative change and an outbox record in one MySQL transaction. A dispatcher delivers outbox records at least once.

Projection Consumers use a stable source identity plus a monotonic source revision, or equivalent external versioning, so duplicate and reordered delivery cannot replace newer indexed state with older state.

Deletion produces a durable tombstone carrying the source identity and revision. Consumers retain enough ordering information to prevent an older create or update from resurrecting a deleted document.

A rebuild reads authoritative state, writes a new projection generation, verifies scoped counts and revisions, and changes serving routing only after reconciliation. Search-domain APIs expose or account for projection lag where stale results affect product behavior.

## Lifecycle and observability

- Startup validates configuration, constructs each client, verifies the Elasticsearch product and supported version, and performs a lightweight connectivity check before publishing the binding.
- Runtime admission rejects new operations after disposal begins. Disposal waits within the configured bound and closes each client before local transport ownership ends.
- Metrics include active operations, operation latency, retry count, node availability, classified failures, startup state, shutdown overruns, oldest pending outbox age, and rebuild progress. Labels use binding and bounded operation names rather than tenant or resource ids.
- Logs correlate request id, binding, operation name, and source revision when safe. They omit query DSL, document content, result hits, credentials, and signed headers.

Cluster capacity, snapshots, restore, cross-region replication, index retention, and disaster-recovery objectives belong to deployment operations. Restoring authoritative data invalidates affected projections and triggers reconciliation or rebuild before those search domains report readiness.

## Alternatives considered

**Put search-domain behavior in the connection package.** Rejected because mappings, tenant predicates, document schemas, and freshness behavior depend on each domain's authority and cannot be enforced correctly by a generic cluster client.

**Treat Elasticsearch as the authoritative application database.** Rejected because refresh timing, projection rebuilds, and search-oriented schemas do not provide the transaction, replay, or authorization guarantees owned by MySQL and durable event logs.

**Filter unauthorized hits after Elasticsearch executes the query.** Rejected because the query has already exposed cross-tenant existence, counts, scores, aggregations, timing, and resource use.

**Choose shared indexes or index-per-tenant as an infrastructure default.** Deferred because either choice can be wrong without measured tenant count, document volume, query patterns, shard limits, and isolation requirements.

## Acceptance criteria

- A shared infrastructure contract suite runs against a supported Elasticsearch server and covers authenticated startup, compatibility rejection, timeout, cancellation, classified failures, admission, and awaited disposal.
- Configuration tests reject malformed endpoints, credential conflicts, unsafe server TLS settings, invalid retry or timeout limits, missing bindings, and duplicate bindings without exposing secret values.
- Tenant-domain integration tests use valid resources from two tenants and prove that search, count, aggregation, lookup, update, and deletion send a tenant predicate before Elasticsearch executes them.
- Outbox tests duplicate and reorder deliveries, interrupt dispatch after MySQL commit, and prove convergence by source revision including deletion tombstones.
- Rebuild tests create a new projection generation from authoritative state, reconcile counts and revisions per tenant, and prove that failed or partial generations never become serving indexes.
- Assembled Host tests prove that remote, model, container, and microVM paths cannot obtain the Elasticsearch service, cluster credentials, or unrestricted index access.
- Operational tests verify bounded labels and confirm that logs, metrics, resolved configuration, and classified errors omit credentials, request bodies, document content, and result hits.

## Risks

- **Tenant enforcement remains domain-owned.** A Consumer that bypasses its query builder can issue an unscoped request; least-privilege credentials, narrow APIs, and two-tenant integration tests reduce but do not eliminate that trusted-code risk.
- **At-least-once delivery requires correct versioning.** An omitted or non-monotonic source revision can let duplicate, reordered, or delayed work corrupt the projection.
- **Shutdown bounds can leave an unknown remote outcome.** Closing a transport after the bound cannot prove whether an in-flight indexing request committed; reconciliation must resolve it.
- **Topology choices can create operational limits.** Shared indexes concentrate isolation risk, while index-per-tenant layouts can exhaust shard and control-plane capacity; the first domain must measure both before selecting a default.
