# @deepseek-ai/dsh-elasticsearch

English | [中文](README.zh.md)

Host-only Elasticsearch client service for search-projection domain plugins. The package exposes `ctx.elasticsearch.operation(callback)`, owns one official Elasticsearch JavaScript client, verifies connectivity during startup, and drains admitted callbacks before closing the client. The [Elasticsearch infrastructure reference](../../../docs/infrastructure/dsh-elasticsearch.md) maps current ownership; search domains retain authorization, queries, indexes, mappings, documents, outbox consumption, and rebuilds.

## Configuration

| Key | Required | Meaning |
|---|---|---|
| `node` | yes | Absolute HTTP(S) Elasticsearch node URL; path prefixes are allowed, while credentials, queries, and fragments are forbidden |
| `auth.username` and `auth.password` | no | Basic authentication pair; the password is marked as a secret |
| `auth.apiKey` | no | Base64-encoded API key marked as a secret |
| `auth.bearer` | no | Bearer or service-account token marked as a secret |
| `caFingerprint` | no | SHA-256 CA fingerprint as 64 hexadecimal digits or 32 colon-delimited hexadecimal bytes |
| `allowInsecureHttp` | no | Explicit trusted-local opt-in for plaintext HTTP; defaults to `false` |
| `maxRetries` | yes | Official-client retry default; a callback may override it with per-request options |
| `requestTimeoutMs` | yes | Official-client request-timeout default in milliseconds; a callback may override it per request |
| `pingTimeoutMs` | yes | Maximum startup and connection-pool ping duration in milliseconds; `1..2147483647` |

Authentication may be omitted for a cluster that explicitly disables security. Otherwise configure exactly one complete basic, API-key, or bearer strategy with non-empty fields. Only `username`, `password`, `apiKey`, and `bearer` are accepted inside `auth`; the service rejects every unknown field, including one placed beside a valid strategy. It also rejects malformed URLs, URL queries or fragments, credential-bearing URLs, plaintext HTTP without the explicit opt-in, malformed or HTTP-only CA fingerprints, incomplete basic authentication, conflicting authentication strategies, and ping timeouts above the Node timer limit before constructing the client.

The client enables its metadata redaction in replacement mode. This package does not log configuration, request bodies, response hits, or connection errors, so credentials and protected search content are not copied into package-owned diagnostics.

## Operation lifecycle

Startup calls `ping()` once with retries disabled and applies `pingTimeoutMs` to that request. Consumer calls to `operation(callback)` reject until the ping returns `true` and plugin activation completes. An admitted operation invokes the callback with a borrowed view of the shared official client. That TypeScript view includes the official request methods, overloads, and helpers but makes direct access to `close()`, `child()`, transport internals, and client metadata unavailable. The callback may return materialized response data or a promise, but it must not retain the client; it must await client-backed requests and fully consume or close client-backed streams and async iterators before its result settles. The type restriction does not turn a trusted Host callback into a runtime sandbox. A disposal request stops admission as soon as the plugin fiber begins unloading, including while the startup ping is pending. Teardown waits for every admitted callback and calls `client.close()` only after they settle. A startup ping that throws or returns `false` closes the client before plugin activation rejects.

The client exposes the Elasticsearch API directly to trusted Host Consumers. Official per-request options may override the configured retry and request-timeout defaults. This infrastructure layer does not construct queries or select indexes, so each Consumer remains responsible for those request choices and for injecting an authoritative tenant filter before execution.

## Model Experience

### Elasticsearch connection

#### What the model sees

Nothing. `ctx.elasticsearch` is available only to trusted Host plugins; this package registers no tools, prompts, messages, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: Elasticsearch client activity never changes a request prefix.

## Known Limitations and Deferred Work

- **Connection-only API** — error classification, health reporting, telemetry, named bindings, cancellation policy, and a shutdown deadline are not implemented yet.
- **System trust only** — custom CA files, managed-cloud discovery, node discovery, proxy configuration, and client-certificate authentication remain deferred; `caFingerprint` is the only additional TLS trust input.
- **Borrowed, not isolated** — official `meta: true` responses and typed transport errors may carry connection metadata, and trusted code can cast or retain the runtime client; Consumers must treat those values as read-only diagnostics and never use them to control the shared transport.
- **Static bootstrap authentication** — credentials are fixed for the service lifetime; rotation requires plugin reload.
- **No search domain** — index templates, mappings, tenant query construction, outbox delivery, bulk indexing, tombstones, projection lag, and rebuild tooling belong to later Consumer packages.
