# @deepseek-ai/dsh-file-storage

English | [中文](README.zh.md)

Provider-neutral immutable file-object storage. `ctx.fileStorage` lets domain plugins stream arbitrary bytes into a durable object and persist the returned `FileObjectRef` without learning a filesystem path, remote URL, bucket, or provider-specific key format.

`put()` consumes an `AsyncIterable<Uint8Array>`. It resolves only after the provider has consumed the complete stream, checked optional `expectedSha256` and `expectedByteSize`, durably published immutable bytes, and made the object immediately available to `open()` and `stat()`. Empty objects are valid. Repeated content may deduplicate to the same reference. A failed write returns no reference, although unreachable provider bytes can remain for later garbage collection.

Every reference carries an opaque branded `objectId`, `storageBackend`, and `storageKey` plus lowercase SHA-256 and exact byte length. Consumers persist every field verbatim and route the reference back to the named provider; they never parse a key as a path or URL. `open()` resolves a ready object to an asynchronous byte stream and verifies the reference, digest, and length. `stat()` returns only `status: 'ready'` and canonical reference metadata. Providers reject references for another backend.

`FileStorageError` reports stable operation and category fields without embedding object keys, paths, URLs, content, or provider diagnostics in its message. Categories distinguish invalid references, caller-supplied checksum or size mismatches, missing and corrupt objects, provider unavailability, and read, write, or metadata failures. Providers preserve an `AbortSignal` reason instead of translating cancellation into `FileStorageError`.

This package owns no tenant, user, Conversation, message, retention, path, download-authorization, or database policy. Domain plugins establish ownership and lifecycle around an opaque ready reference. Providers implement physical storage and run the shared suite in `tests/contract.ts`.

## Model Experience

### File-object storage

#### What the model sees

`None`. Consumers can expose authorized file references through their own logged messages or tools.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- The service exposes `put`, `open`, and `stat`; deletion, retention, garbage collection, range reads, and multipart-resume protocols remain domain- and provider-owned future work.
- The first provider is local storage; S3-compatible and MinIO providers are deferred.
- The contract has no registry for multiple simultaneous backends in one Cordis context.
