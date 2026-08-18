# @deepseek-ai/dsh-redis

English | [中文](README.zh.md)

Host-only Redis connection service for multi-user domain plugins. The package exposes `ctx.redis.withClient(callback)`, owns one standalone `@redis/client` connection, verifies `connect()` and `PING` during startup, rejects callbacks while the client is not ready, and drains admitted callbacks before closing. Cache, rate-limit, lease, idempotency, invalidation, and Pub/Sub behavior remains in separate domain Consumers under the [dsh-redis infrastructure rules](../../../docs/infrastructure/dsh-redis.md).

## Configuration

| Key | Required | Meaning |
|---|---|---|
| `url` | yes | Standalone `redis:` or `rediss:` URL; the config schema marks the complete value as a secret |
| `connectTimeoutMs` | no | Total startup connection and `PING` timeout, also used for the socket connection attempt; defaults to `10000` and must not exceed `2147483647` |

The service rejects plugin activation for an invalid scheme, missing host, invalid timeout, connection timeout, authentication failure, or failed `PING`. Package-authored diagnostics never interpolate the URL or credentials; underlying Node Redis errors propagate and may identify a network endpoint. The package logs at most one generic warning during each unavailable interval and permits another after a `ready` event.

## Client lifecycle

`withClient(callback)` passes one shared multiplexed client to a callback; it does not lease an exclusive connection. The callback must settle every command it starts and must not retain, close, duplicate, subscribe, or otherwise change the client's connection state. Blocking commands, Pub/Sub, and `WATCH`-scoped transactions require separately owned clients and are unsupported through this method.

The offline command queue and automatic reconnect are disabled. Calls made while the client is not ready reject instead of waiting, and an unexpected disconnect leaves the service unavailable until its plugin is remounted. Disposal stops admission, waits for every accepted callback, calls `client.close()` while connection-error handling remains attached, and then removes the package-owned `error` and `ready` listeners. Startup timeout uses `client.destroy()` so connection work cannot outlive failed activation.

## Model Experience

### Redis connections

#### What the model sees

Nothing. `ctx.redis` is available only to trusted Host plugins; this package registers no tools, prompts, messages, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: Redis connection activity never changes a request prefix.

## Known Limitations and Deferred Work

- **One standalone command client** — named bindings, pools, replicas, Sentinel, Cluster, blocking commands, Pub/Sub, and dedicated transaction clients remain deferred.
- **No automatic reconnect** — an unexpected disconnect requires plugin remount; a future reconnect policy must own cancellable retry state and wait for it during disposal.
- **Connection-only API** — domain cache operations, limiters, leases, outbox consumption, health reporting, metrics, and Redis error classification are not implemented.
- **Unbounded callback drain** — disposal waits for admitted callbacks without a shutdown deadline; Consumers must settle every command and callback they start.
