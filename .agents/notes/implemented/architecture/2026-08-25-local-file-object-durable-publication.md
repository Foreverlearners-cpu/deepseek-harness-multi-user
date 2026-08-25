# Agent Note: Durable local file-object publication

Status: implemented

English | [中文](2026-08-25-local-file-object-durable-publication.zh.md)

## Problem

An immutable file-object reference can outlive the process that created it. Returning before file bytes and every new directory entry are durable can produce a valid database reference whose object disappears after a crash. Concurrent publishers also need one no-clobber commit point without process-local locks.

## Decision

`@deepseek-ai/dsh-file-storage-local` uses SHA-256 content addressing below an explicitly configured private root. A write streams into a random owner-only file in a same-filesystem staging directory, computes complete-object digest and length, flushes the file, and publishes it with an atomic hard link. `EEXIST` means another publisher won; the provider verifies that existing object's metadata and bytes before returning the same reference.

Directory creation establishes a durability chain from each new leaf through the nearest known existing ancestor. Publication and deduplication flush every directory from the digest bucket through the storage root. Windows skips directory flush because Node cannot open directory handles there, while file flush and atomic hard-link publication still apply.

References expose only a relative opaque content key. The provider derives and cross-checks the backend, object id, key, digest, and byte length before path resolution. `open` verifies the digest and length as the caller consumes the stream. Cancellation does not wait for a source iterator that remains blocked in its own asynchronous work; its eventual cleanup rejection is observed without delaying staging cleanup.

## Alternatives considered

**Rename publication.** Rename can replace an existing object and therefore needs an external lock to preserve immutable concurrent publication. Hard-link creation supplies one atomic no-clobber commit point.

**Process-local publisher locks.** They do not coordinate multiple processes and add mutable lifecycle state. Content addressing plus hard-link `EEXIST` works across processes.

**Absolute paths in references.** They expose deployment layout and prevent moving a persisted object tree. An opaque relative key keeps physical root policy inside the Provider.

## Consequences

Identical bytes deduplicate without a registry or lock service, and a returned reference remains readable after restart. Reads spend CPU on SHA-256 verification, duplicate writes reread the winner before returning, and a late directory-flush failure may leave an unreachable immutable object. The API intentionally has no deletion operation; ownership, retention, and garbage collection remain outside this Provider.
