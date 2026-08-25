# @deepseek-ai/dsh-file-storage-local

English | [中文](README.zh.md)

Local filesystem provider for [`@deepseek-ai/dsh-file-storage`](../file-storage/README.md). Configure an explicit private `root`; the plugin registers `ctx.fileStorage` with backend identity `local`.

`put()` streams caller bytes into a random owner-only staging file below `root`, computes SHA-256 and byte length, flushes the file, and publishes it under a content-addressed object key through an atomic hard link. The staging and object trees share one filesystem. The provider flushes the object directory on platforms that support directory `fsync`, so a returned reference is durable and immediately readable after process restart. Concurrent writes of identical bytes converge on one immutable object and return the same reference.

References contain an opaque relative key such as `objects/sha256/ab/cd/<digest>`; they never contain the configured root or another absolute path. The provider binds backend, object id, key, digest, and byte length. `stat()` validates these fields and filesystem metadata. `open()` also computes SHA-256 and length while the consumer iterates the stream and reports a corrupt object instead of returning successful EOF when either differs.

Cancellation preserves the `AbortSignal` reason and removes the operation's staging file. Failed publication returns no reference; bytes already published before a late durability failure can remain unreachable. There is no delete operation, retention policy, tenant policy, URL generation, MinIO, or S3 support.

```yaml
- name: file-storage-local
  config:
    root: /var/lib/dsh/file-objects
```

## Model Experience

### Local file-object storage

#### What the model sees

`None`. Domain consumers decide whether an authorized object appears in model-visible logged data.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- This provider supports one configured local root and whole-object reads. Range reads, deletion, retention, garbage collection, encryption at rest, and remote backends are not implemented.
- Directory `fsync` is skipped on Windows because Node cannot open directories there; file flush and atomic hard-link publication still apply.
