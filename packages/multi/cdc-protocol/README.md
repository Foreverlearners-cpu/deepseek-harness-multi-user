# @deepseek-ai/dsh-cdc-protocol

English | [中文](README.zh.md)

Transport-independent types and a strict codec for version-one CDC row events. Producers and consumers can share the wire format without importing MySQL drivers, binlog readers, Cordis services, or Kafka transport code.

## Wire format

`CdcEvent` identifies one `insert`, `update`, or `delete` by `eventId`, canonical UTC `occurredAt`, MySQL source coordinate, non-empty compound `key`, row images, optional `changedColumns`, and `schemaFingerprint`. Insert events carry only `after`, update events carry both images, and delete events carry only `before`. `CdcCheckpoint` describes the version-one producer restart coordinate but this package does not read or write checkpoint storage.

`encodeCdcEvent()` validates typed input before publication. `decodeCdcEvent()` treats bytes as untrusted: it rejects empty or oversized payloads, malformed UTF-8, invalid JSON, unsupported `specVersion`, unknown top-level or source fields, invalid values, inconsistent row images, and incomplete `changedColumns`. Both functions accept a smaller `maxBytes`; the absolute codec ceiling is `MAX_CDC_WIRE_BYTES` (64 MiB). Failures are `CdcWireError` instances with stable `code` values and diagnostics that never include row contents.

`encodeKey()` preserves JavaScript property insertion order so producers must construct compound keys in configured primary-key order. `findChangedColumns()` performs deep JSON-value comparison, while `getChangedColumns()` preserves an explicit version-one list and derives one for older version-one records that omit it.

## Model Experience

### CDC protocol

#### What the model sees

`None`. This package has no model-facing output.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- Version one models MySQL binlog coordinates and full row images; other source coordinate systems require a later protocol version.
- The codec has no schema registry and does not prove that `schemaFingerprint` matches a live database schema.
- JSON parsing cannot detect duplicate object member names after the JavaScript parser has selected the final value.
