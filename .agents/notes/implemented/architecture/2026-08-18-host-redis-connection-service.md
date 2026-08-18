# Agent Note: Host Redis connection service

Status: implemented

English | [中文](2026-08-18-host-redis-connection-service.zh.md)

## Problem

Multi-user domain plugins need Redis for rebuildable caches, rate limits, short-lived coordination, and invalidation wakeups. Letting each Consumer construct a raw client would duplicate target validation, startup checks, error-listener ownership, reconnect policy, credential handling, and disposal. It would also make it easy for a Consumer to retain a client beyond its plugin lifetime or expose Redis directly across the Host trust boundary.

Redis cannot be the authority for identity, membership, grants, ownership, durable sessions, audit records, or other state whose loss would change authorization or correctness. A shared connection package therefore needs narrow lifecycle ownership without inventing domain cache or coordination semantics before their Consumers exist.

## Decision

`@deepseek-ai/dsh-redis` is a Host-only Cordis service that combines the Redis Service Definition and Service Provider. It owns one standalone `@redis/client` command connection and exposes it as `ctx.redis.withClient(callback)`. Domain plugins remain the Consumers and own key namespaces, trusted tenant derivation, serialization, TTLs, atomic commands, authorization, retries, and outage policy.

The package validates one absolute `redis:` or `rediss:` URL with a host. Its `connectTimeoutMs` config defaults to `10000`, cannot exceed Node's `2147483647` millisecond timer maximum, bounds the socket connection attempt, and provides one total deadline for initial `connect()` plus `PING`. The complete URL is a secret config value and package-authored diagnostics contain no endpoint or credential fields.

The client disables its offline command queue and automatic reconnect. Activation installs package-owned `error` and `ready` listeners, connects, and requires `PING` before admitting callbacks. A timeout destroys the client so connection work cannot outlive failed activation. Other activation failures unwind the registered resource effect and close an opened client. An unexpected disconnect leaves the service unavailable until plugin remount. The package records one generic warning per unavailable interval; after `ready`, a later unavailable interval can produce another warning.

`withClient` admits work only while the service accepts callbacks and the Node Redis client is ready. Admission happens synchronously before callback invocation. The service tracks each admitted callback, returns its result unchanged, and removes it from the active set after settlement. The callback must await every command it starts and cannot retain, close, duplicate, subscribe, or reconfigure the shared client. Blocking commands, Pub/Sub, `WATCH`-scoped transactions, and other connection-stateful operations are outside this API.

Disposal first stops admission, then waits for all admitted callbacks and closes an open client while the connection-error listener remains attached. It removes package-owned listeners after the close settles, preventing a socket failure during close from becoming an unhandled EventEmitter error. Disposal reaches quiescence for service-owned resources; it deliberately has no deadline because aborting an arbitrary Redis command cannot prove that Consumer work has stopped.

Redis state is disposable and rebuildable. A domain Consumer obtains tenant scope from an authenticated call and enforces authorization against authoritative state before constructing or reading a key. Redis misses, stale values, evictions, restarts, and outages cannot grant authority. The client, URL, credentials, and network remain unavailable to Typert, API Proxy, tools, model-controlled containers, and microVMs.

## Verification

Unit coverage exercises URL and timeout validation, resolved client options, activation connection and `PING`, generic error deduplication, callback results and failures, readiness refusal, timeout destruction, activation cleanup, listener cleanup, and disposal waiting for concurrent admitted callbacks. Keyless local TCP fixtures exercise the real Node Redis client against a silent peer, an immediate close, and an established connection loss, including the absence of reconnect or late connection work after disposal. An opt-in test uses `DSH_REDIS_TEST_URL` to boot the service against a real Redis server and execute `PING` through `withClient`.

The package has an explained empty invariant companion. Redis availability is external state rather than an owned in-process relationship; lifecycle behavior is asserted at the operation and disposal points instead.

## Alternatives considered

**Construct a client in every domain plugin.** Rejected because connection setup, secret handling, error-listener ownership, and quiescent disposal are common Host responsibilities, while independent clients would multiply sockets and reconnect loops.

**Use Node Redis automatic reconnect.** Rejected because dependency-owned backoff timers cannot be cancelled or awaited through the public client API and can continue after an activation deadline or disposal. A future reconnect design must keep retry state under the service lifecycle; until then, remount is the explicit recovery mechanism.

**Expose a provider-neutral cache or coordination API now.** Rejected because no concrete Consumers yet establish one operation set or failure policy across caches, rate limiters, leases, idempotency hints, and Pub/Sub.

**Use Redis as the authorization or durable state authority.** Rejected because expiry, eviction, restart, stale reads, and partition behavior would turn data loss or lag into incorrect access or lost durable state.

**Expose the raw client through remote or model-facing surfaces.** Rejected because callers could bypass domain authorization, select arbitrary keys and commands, and obtain infrastructure credentials or network reachability.

**Start with pools, Sentinel, Cluster, or dedicated stateful clients.** Rejected because the initial non-blocking command use needs one multiplexed standalone client. Each additional topology or connection mode requires a concrete deployment or Consumer and separate lifecycle semantics.

## Consequences

Connection lifecycle, readiness, secret handling, and callback draining have one package owner, while domain behavior stays with the plugins that understand its correctness and authorization requirements. The initial API is intentionally small and does not yet provide a usable cache, limiter, lease, or Pub/Sub feature by itself.

Consumers must settle every command before returning from `withClient`; one stuck callback can delay disposal indefinitely. An unexpected disconnect makes the service unavailable until remount. Deployments that need automatic recovery, another Redis topology, custom TLS material, stateful commands, or a bounded shutdown policy require a follow-up design with an owning Consumer and tests.
