# Agent Note: dsh-file-storage service

Status: proposed

English | [中文](2026-08-24-dsh-file-storage-service.zh.md)

## Problem

The decoupled MySQL delivery plan needs durable file objects for user-owned attachments, but the coupled candidate left the file contract inside a combined change that also touched Host routes. A provider-agnostic file-object service must exist as its own plugin so conversation persistence and a future webserver route can share one contract without modifying core, Host, or default bundle packages.

## Proposal

Add `@deepseek-ai/dsh-file-storage` under `packages/storage/file-storage` as a provider-agnostic file-object Service Definition with a local content-addressed implementation. `ctx.fileStorage.put(data, expectedSha256?)` publishes immutable bytes by SHA-256 and returns a provider-local `FileObjectRef`; `get(storageKey, expectedSha256, signal?)` reads and verifies bytes. The default provider stores objects under a configured local root and does not materialize the root until the first write.

### Content addressing and safety

Objects are stored under `objects/<first-two-sha256>/<sha256>`; publishing is idempotent and concurrent-safe through temporary-file rename. Reads validate the digest and reject keys that escape the configured root.

### Provider seam

Consumers depend on the `FileObjectStore` contract, not on filesystem paths, so an S3 or MinIO provider can replace the local implementation without changing conversation or message tables.

## Alternatives considered

**Fold file storage into the conversation persistence provider.** Not adopted: files have an independent lifecycle and storage backend, and the delivery plan requires one plugin per capability.

**Add file routes to the Host API in this branch.** Not adopted: transport routes belong to a separate webserver-extension plugin; this branch keeps the storage contract and local provider only.

## Acceptance criteria

- `ctx.fileStorage` publishes, deduplicates, and verifies content-addressed bytes under a configured local root.
- Reads reject path traversal and checksum corruption; publishing is idempotent under concurrent duplicates.
- The package depends only on upstream packages and changes no existing package.
- Unit tests cover round-trip, digest mismatch, tampering, lazy root creation, and invariant registration.

## Risks

Local content addressing is single-host: a multi-host deployment needs a shared object store, which is a future provider rather than this branch. The root is deliberately explicit configuration; misconfiguration can place objects outside the intended durable volume.
