# `@deepseek-ai/dsh-file-storage`

English | [中文](README.zh.md)

The `fileStorage` Cordis service stores immutable file bytes behind a small provider-neutral contract. The default provider is a local content-addressed store; a future S3 or MinIO provider can implement the same `FileObjectStore` contract without changing message or file metadata tables.

## Service

- `ctx.fileStorage.put(data, expectedSha256?)` publishes bytes and returns the digest, provider key, backend name, and byte size.
- `ctx.fileStorage.get(storageKey, expectedSha256, signal?)` reads bytes and verifies the digest before returning them.
- Objects are written as `objects/<first-two-sha256>/<sha256>` under the configured root. Identical content is written once and then reused.

The service owns file bytes only. A conversation plugin owns user/session metadata, authorization, and message links in MySQL; it stores the returned `storageBackend` and `storageKey` as metadata.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required | Durable local object root; no cwd fallback is used. |

## Model Experience

### File objects

#### What the model sees

Nothing directly. The service is a host-side capability exposed as `ctx.fileStorage` and used by persistence and attachment plugins.

#### Token effect

Zero direct tokens. Only the consuming plugin decides whether a file is exposed to a model.

#### KV Cache effect

None. File reads and writes do not modify the model prompt prefix.

## Known Limitations and Deferred Work

- The shipped implementation is local-only. S3 and MinIO adapters are intentionally deferred; they can replace the provider while keeping the contract and MySQL metadata unchanged.
- The service does not perform user authorization. Callers must enforce ownership before calling `get()`.
