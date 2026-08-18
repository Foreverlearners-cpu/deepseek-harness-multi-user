# Elasticsearch infrastructure

English | [中文](dsh-elasticsearch.zh.md)

This reference maps the Elasticsearch infrastructure that exists in the repository. [`@deepseek-ai/dsh-elasticsearch`](../../packages/multi/elasticsearch/README.md) provides Host-only connectivity; search-domain plugins retain authorization, tenant-scoped queries, indexes, documents, projection delivery, and rebuild policy. The [tenant-scoped search-projection proposal](../../.agents/notes/proposed/architecture/2026-08-18-tenant-scoped-elasticsearch-search-projections.md) owns the design that has not been implemented.

## Current service

`ctx.elasticsearch` owns one official Elasticsearch JavaScript client for one explicitly configured HTTP(S) node. Configuration selects authentication, TLS fingerprint policy, retry defaults, request timeout, and startup ping timeout. The [package README](../../packages/multi/elasticsearch/README.md#configuration) is the configuration and failure reference; the [multi-user infrastructure subsystem](../subsystems/multi-user-infrastructure.md#elasticsearch-connection) contains the generated Cordis API.

Plugin activation succeeds only after one non-retried `ping()` completes within `pingTimeoutMs`; Consumer operations reject until activation completes. Trusted Host Consumers call `operation(callback)` with a borrowed official-client API. Disposal stops admission, waits for admitted callbacks to settle, and then closes the client. The callback lifetime and stream-consumption requirements are part of the package contract.

## Trust and ownership

Typert, API Proxy, model tools, containers, and microVMs do not receive the service or its bootstrap credentials. The TypeScript borrowing restriction prevents direct accidental transport or lifecycle control, but it is not a runtime sandbox for trusted Host code.

The service does not authorize requests, select indexes, inject tenant predicates, or validate a domain's query fields. A search-domain Consumer must derive tenant identity from authenticated authority and place the tenant predicate in the Elasticsearch request before execution; filtering returned hits cannot prevent cross-tenant leakage through counts, scores, aggregations, timing, or resource use.

Elasticsearch is a rebuildable projection, not authoritative state. MySQL or the owning durable event log remains authoritative for mutations, authorization, replay, reconciliation, and deletion ordering. A Consumer must not fall back to an unscoped query when Elasticsearch is unavailable.

## Planned projection work

Named bindings, classified transport failures, health and telemetry APIs, tenant query enforcement, outbox delivery, external versioning, tombstones, and generation-based rebuilds remain proposal work. Their ownership, alternatives, acceptance criteria, and risks live in the [tenant-scoped search-projection Agent Note](../../.agents/notes/proposed/architecture/2026-08-18-tenant-scoped-elasticsearch-search-projections.md).
