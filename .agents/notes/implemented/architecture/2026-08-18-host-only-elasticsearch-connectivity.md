# Agent Note: Host-only Elasticsearch connectivity

Status: implemented

English | [中文](2026-08-18-host-only-elasticsearch-connectivity.zh.md)

## Problem

Multi-user search projections need a maintained Elasticsearch client, but letting every search domain construct its own client would duplicate bootstrap-secret handling, transport settings, startup checks, and shutdown behavior. Exposing a raw cluster client outside trusted Host plugins would also create paths that bypass domain authorization and tenant-scoped query construction.

The connection package needs connectivity without owning index mappings, search APIs, outbox delivery, or rebuild policy. The [tenant-scoped search-projection proposal](../../proposed/architecture/2026-08-18-tenant-scoped-elasticsearch-search-projections.md) owns those future decisions.

## Decision

`@deepseek-ai/dsh-elasticsearch` is a Host-only Cordis service at `ctx.elasticsearch`. It owns one official Elasticsearch JavaScript client and validates one explicit node whose optional path prefix is preserved while credentials, queries, and fragments are rejected. Authentication is absent or uses exactly one complete basic, API-key, or bearer strategy; unknown fields fail even beside a valid strategy. Plaintext HTTP requires trusted-local opt-in, and an HTTPS CA fingerprint must contain 64 hexadecimal digits or 32 colon-delimited hexadecimal bytes.

Before plugin activation succeeds, the service performs one non-retried `ping()` under `pingTimeoutMs`, which is bounded by Node's maximum timer delay. Consumer operations reject until that startup check returns `true` and the owning Cordis fiber becomes active. A disposal request makes the owner fiber non-active before teardown runs, so admission closes immediately even while the ping is pending. Consumers run active work through `operation(callback)`. Its borrowed TypeScript client API retains official request methods, overloads, and helpers while making direct lifecycle controls, transport internals, and client metadata unavailable. A callback may return materialized response values, but it must not retain the client; it must await client-backed requests and fully consume or close client-backed streams and async iterators before its result settles. The service waits for every admitted callback including failures and then awaits `client.close()`. Consumers retain ownership of indexes, documents, tenant filters, query construction, eventual-consistency behavior, and projection rebuilds. Typert, API Proxy, model tools, containers, and microVMs never receive the service or its credentials.

Transport retry and timeout values are required configuration rather than package defaults. The package passes `maxRetries` and `requestTimeoutMs` as official-client defaults, which trusted callbacks may override through official per-request options, and enables client metadata redaction. It does not log connection configuration, requests, responses, or protected content. `requestTimeoutMs` is not given the ping limit because it is consumed by the maintained transport rather than by the startup abort timer.

## Implementation lessons

The client wrapper is small, but repository integration is the dominant delivery cost. A new Host package participates in workspace resolution, Host compiler faces, generated package and Cordis catalogs, dependency analysis, third-party notices, package invariants, bilingual documentation, and publication checks. Most elapsed time therefore belongs to proving that the package is part of the repository correctly, not to calling `new Client()`.

Security and lifecycle behavior account for the other deliberate cost. Authentication modes must be mutually exclusive, plaintext transport must require explicit opt-in, startup connectivity must have a bounded non-retried failure path, and disposal must reject new work while awaiting admitted callbacks. Encoding and testing these rules in the infrastructure service prevents each search domain from inventing subtly different behavior.

The maintained official client and a connectivity-only package keep owned protocol code and domain policy out of this layer. A module-level client double makes startup and lifecycle races deterministic, a local HTTP fixture verifies the actual transport, and an opt-in real-cluster smoke verifies deployment compatibility. This layering separates fast logic feedback from dependency and deployment evidence.

For similar infrastructure packages, define ownership and trust restrictions before the service API, keep the first package to one owned responsibility, test startup and disposal races before adding domain behavior, and retain an optional real-service smoke. Repository integration remains a planned part of the work because package catalogs, compiler faces, dependency analysis, notices, invariant companions, bilingual documentation, and publication checks all consume the package metadata.

## Alternatives considered

**Let each search domain construct an Elasticsearch client.** Rejected because credential handling, transport policy, startup failure, and quiescent shutdown would diverge across Consumers while adding no domain-specific value.

**Expose a generic provider-independent search service.** Rejected for this milestone because no second provider or concrete search Consumer establishes a stable common API, and hiding the Elasticsearch query model would make failure and consistency semantics less explicit.

**Expose the client through remote or model-controlled APIs.** Rejected because possession of a cluster client is not authorization. Domain services must construct tenant-scoped operations before Elasticsearch executes them.

**Implement mappings, outbox indexing, and rebuilds in this package.** Rejected because those behaviors depend on each projection's authoritative source, document schema, retention, and product freshness requirements.

## Consequences

The first package provides one explicit cluster target with basic, API-key, bearer, or unauthenticated bootstrap; HTTPS is the default requirement, with strict SHA-256 CA fingerprint support. Invalid security fields and timer values fail before the client is constructed. Startup fails when connectivity or authentication fails, and shutdown reaches callback quiescence before transport close. The borrowed API prevents direct accidental lifecycle control in typed Consumers, but official response and error metadata may still carry connection objects, and trusted callbacks can retain or cast the runtime object. Consumers must treat transport metadata as read-only diagnostics and follow the documented lifetime. Bootstrap credentials remain fixed until plugin reload.

The package does not yet provide named bindings, custom CA files, managed-service discovery, classified failures, health telemetry, cancellation policy, or a bounded shutdown deadline. Search-domain integration and a supported-version compatibility matrix remain separate work; unit coverage proves configuration, startup, callback admission, failure propagation, and disposal against the official client API, while an opt-in real-cluster smoke proves startup and callback access through Cordis.
