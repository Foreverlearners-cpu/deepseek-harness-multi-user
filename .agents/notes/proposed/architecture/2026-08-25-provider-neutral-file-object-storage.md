# Provider-neutral file-object storage

English | [中文](2026-08-25-provider-neutral-file-object-storage.zh.md)

## Context

Conversation persistence needs durable references for generated files and oversized semantic records. Existing attachment storage provides strong local durability for admitted images, while spill storage intentionally provides temporary session-scoped text without a read or retention contract. Neither service can represent arbitrary permanent file objects without widening its current responsibility.

## Decision

`@deepseek-ai/dsh-file-storage` defines one immutable object service independently from physical storage and business ownership. `put` consumes an asynchronous byte stream and returns only after complete-object SHA-256, byte length, durable publication, and immediate readability are established. `open` returns an asynchronous byte stream, and `stat` resolves canonical metadata only for ready objects.

The serializable reference contains opaque branded object, backend, and key identifiers plus SHA-256 and byte length. Providers own the meaning of all identifiers. Consumers persist them without parsing them and separately enforce tenant, user, Conversation, message, retention, and download authorization.

Stable `FileStorageError` categories let Consumers distinguish invalid input and references, missing or corrupt objects, provider unavailability, and failed operations without disclosing physical locations or provider diagnostics. Cancellation preserves the caller's abort reason.

The Service Definition and each Provider are separate plugins. The first Provider uses private local content-addressed storage and must reuse the attachment backend's durable-publication properties. A shared conformance suite holds every Provider to streaming, immutability, ready-state, integrity, cancellation, and error-classification semantics.

## Alternatives

Extending `ctx.attachments` would couple generic files to image admission, dimensions, media allowlists, and model image resolution. Using `ctx.spillStore` would persist references whose default storage is temporary and whose contract has no read operation. Storing bytes in MySQL would enlarge high-frequency relational transactions and duplicate object-storage behavior. Combining the local Provider with the Service Definition would make physical policy part of every Consumer's dependency graph.

## Consequences

Domain plugins need an additional transaction that records ownership after object publication. A database failure can leave an unreachable immutable object, so reference-aware garbage collection remains necessary. The minimal API defers deletion, range reads, resumable multipart upload, and a multi-backend registry until a current Consumer requires them.

## Verification

The Service Definition runs focused unit coverage and an exported provider conformance suite. The local Provider must run that suite plus crash-durability, concurrent publication, corruption, path-escape, restart, and large-stream tests.
