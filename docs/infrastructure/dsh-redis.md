# dsh-redis infrastructure

English | [中文](dsh-redis.zh.md)

This reference defines the Host-only `@deepseek-ai/dsh-redis` service and the ownership rules for Redis-backed multi-user features. The initial package owns one standalone Node Redis client and its connection lifecycle. Domain Consumers own cache, rate-limit, lease, idempotency, invalidation, and Pub/Sub behavior.

## Scope

`dsh-redis` validates one Redis target, connects and sends `PING` during activation, admits callback-scoped client use, stops admission during disposal, waits for admitted callbacks, and closes its client. It is a trusted Host dependency and is never projected through Typert, API Proxy, tools, or model-controlled execution environments.

The service does not allocate keys, derive tenant scope, serialize domain values, select TTLs, implement authorization, or decide whether a Redis outage fails open or closed. Each domain Consumer owns those decisions because their correctness and security consequences differ.

Redis data must be disposable and rebuildable. Durable identity, grants, sessions, settings, audit records, and other authoritative records remain in their owning durable stores. A Redis miss, restart, eviction, stale value, or outage cannot create authority or grant access.

The package contributes no prompts, tool schemas, messages, session events, or other model-visible data. A Consumer that uses Redis while preparing model-visible input must still be able to reconstruct that input from its durable state and session events.

## Package position

| Package or component | Role | Owned data or behavior |
|---|---|---|
| `@deepseek-ai/dsh-redis` | Redis Service Definition and Service Provider | Client configuration, activation check, callback admission, connection lifecycle, and package diagnostics |
| Domain Redis plugin | Consumer behind a domain service | Key namespace, tenant scope, serialization, TTL, atomic operation, authorization, and outage policy |
| Durable change publisher | Authoritative change producer | At-least-once invalidation or projection record, stable event id, source revision, and deletion fact |

A provider-neutral cache or coordination service is extracted only after concrete Consumers demonstrate an API that does not erase important differences among caches, limiters, leases, and Pub/Sub. Domain services depend on `dsh-redis` only inside trusted Host compositions; remote callers continue to use domain services that enforce authorization.

## Initial service model

```text
ctx.redis
  withClient(callback) -> result
```

`withClient(callback)` passes the service-owned Node Redis client to one callback and returns the callback result. Admission completes before the callback starts, so disposal waits for every admitted operation. The callback must await all commands it starts and must not retain, close, duplicate, or reconfigure the client, add persistent listeners, or change connection state.

The client is one shared multiplexed command connection, not an exclusive lease. The initial API supports ordinary non-blocking commands only. Blocking commands, Pub/Sub subscriptions, `WATCH`-scoped transactions, and other connection-stateful operations require separately owned clients and lifecycle rules; `withClient` does not support them.

The offline command queue and automatic reconnect are disabled. A callback is rejected while the client is not ready; a disconnect race causes affected Node Redis commands to fail instead of retaining unbounded queued work. An unexpected disconnect leaves the service unavailable until plugin remount, while each Consumer handles operation failure according to its domain policy.

## Configuration and activation

| Config key | Required behavior |
|---|---|
| `url` | Names one standalone `redis:` or `rediss:` target, including any deployment-required username, password, and database number |
| `connectTimeoutMs` | Bounds initial connection plus `PING` and the socket connection attempt; defaults to `10000` and must not exceed `2147483647` |

The config schema marks the complete URL as secret because it can contain credentials. Package-authored diagnostics never interpolate the URL, username, password, query parameters, or TLS material. Underlying Node Redis connection and command errors propagate unchanged and can identify a network endpoint, so callers must not combine them with config values in logs. An invalid URL, unsupported scheme, missing host, invalid timeout, connection timeout, authentication failure, or failed `PING` rejects plugin activation.

Production deployments use `rediss:` with server identity verification and a least-privilege Redis ACL user. A logical database number is a keyspace convenience, not a security boundary. Deployment-specific certificate authorities, client certificates, Unix sockets, Sentinel, Cluster, and managed-service identity remain deferred until a concrete profile requires them.

## Domain data rules

Each Consumer owns a stable namespace containing deployment, domain, key-format version, and trusted tenant scope before the resource id. Keys and values must not contain authentication tokens, credential values, raw prompts, message content, or other secrets merely to simplify lookup. A key-format change uses a new version and provides bounded cleanup or natural expiry.

Cache entries, rate-limit buckets, leases, and short-lived idempotency hints have explicit TTLs. The Consumer defines serialization versioning, maximum value size, atomic update mechanism, and treatment of malformed or unknown versions. Unbounded collections, tenant-wide key scans, and request-selected Redis command names are prohibited.

| Use | Correctness rule |
|---|---|
| Cache and revocation acceleration | A miss or malformed value reads the authoritative domain service; stale data cannot bypass a current authorization or revocation check |
| Rate limiting | The Consumer defines fail-open or fail-closed behavior per operation; authentication, credential, and abuse-sensitive limits fail closed when Redis cannot decide |
| Runtime lease | Expiry, pauses, and partitions can produce concurrent holders, so the lease uses fencing or an authoritative revision and cannot alone prove durable ownership |
| Idempotency hint | Redis can suppress duplicate work briefly, while durable mutations still use an authoritative uniqueness or revision rule and a durable change fact |
| Pub/Sub | Messages are best-effort wakeups only; durable replay and recovery read the owning outbox or event log |

At-least-once projection Consumers apply a stable event id and source revision, make repeated delivery idempotent, preserve deletion facts long enough to converge, and expose lag without promoting Redis to the durable event source.

## Tenant isolation and authorization

A domain method derives trusted tenant scope from the authenticated call before constructing a Redis key. The tenant segment prevents accidental collision but does not authorize access: the domain verifies membership, resource ownership, and operation permission through authoritative state before disclosing existence or content.

`dsh-redis` never accepts a request-supplied tenant as authority and exposes no cross-tenant scan helper. A valid resource id from another tenant must reach no unscoped key or channel. Platform-global keys are explicitly classified and unavailable through tenant product repositories.

The Redis network, URL, ACL credentials, and Node Redis client stay outside model-controlled containers and microVMs. Those environments call authorized tools and provider adapters; they never receive `ctx.redis` or direct Redis connectivity.

## Lifecycle, failures, and observability

- Activation creates the client, installs the package-owned `error` and `ready` listeners, connects within the configured bound, and requires a successful `PING` before the service becomes available.
- `withClient` propagates callback and command failures without rewriting them or retrying the callback. A Consumer retries only an idempotent domain operation.
- The package logs one generic connection-error diagnostic per unavailable interval without connection details; a `ready` event permits a diagnostic for a later interval. Domain logs and metrics use bounded operation names and exclude keys, values, tenant ids, credentials, and unbounded resource ids.
- Disposal stops new callbacks, waits for every admitted callback to settle, closes the client while its connection-error listener remains attached, and then removes the package-owned listeners before disposal resolves.
- Liveness does not require a Redis round trip. Future readiness and metrics may report connection state, operation latency, and failures without treating Redis as durable authority.

## Required verification

- Unit tests mock Node Redis and cover validated client options, timeout limits, activation connection and `PING`, callback results and failures, readiness refusal, diagnostic deduplication, activation cleanup, concurrent callback draining, and quiescent disposal.
- Keyless network tests use local TCP fixtures with the real Node Redis client to cover a silent startup, immediate close, established-connection loss, disabled reconnect, and absence of late connection work after disposal.
- An opt-in test uses `DSH_REDIS_TEST_URL` against a real Redis server, boots the Cordis service, executes `PING` through `withClient`, and disposes the connection.
- Future domain tests use two valid tenant scopes and prove key isolation, mandatory expiry, outage policy, malformed-value handling, and idempotent duplicate change delivery.
- Assembled server tests prove that remote, in-process model, and model-controlled execution paths cannot obtain the Redis service or credentials.

## Known limitations and deferred work

- The initial service supports one standalone URL and one shared non-blocking command client. Named bindings, pools, read replicas, Sentinel, Cluster, blocking operations, Pub/Sub, and dedicated transaction clients are deferred.
- Automatic reconnect is unsupported. An unexpected disconnect requires plugin remount; a future reconnect policy must own cancellable retry state and await it during disposal.
- The initial service has no domain cache API, limiter, lease implementation, outbox Consumer, health service, metrics, or Redis error classification.
- Disposal waits for admitted callbacks without a shutdown deadline. Consumers must settle every command and callback they start.

The [Host connection service cookbook](../cookbook/adding-a-host-connection-service.md) explains the implementation and integration pace and gives a repeatable delivery workflow.

The [Host Redis connection service Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-host-redis-connection-service.md) owns the service split and lifecycle decision.
