# @deepseek-ai/dsh-cdc

English | [中文](README.zh.md)

Host-only MySQL row-change capture. The plugin starts at the current binlog tail when no checkpoint exists, publishes configured `INSERT`, `UPDATE`, and `DELETE` row images to Kafka, and resumes from an atomic local checkpoint after restart. It does not copy historical rows.

## Configuration

`host`, `user`, `password`, and the unique replication `serverId` select MySQL; `port` and `connectTimeoutMs` default to `3306` and `10000`. `checkpointFile` must name durable local storage. Each `routes` entry defines `database`, `table`, Kafka `topic`, an ordered non-empty `primaryKey`, and optional `excludeColumns`. Primary-key columns cannot be excluded, and every configured primary-key or excluded column must match MySQL metadata exactly.

`maxEventBytes` limits one serialized row record and defaults to `1048576`. `maxBinlogEventBytes` rejects one decoded MySQL RowsEvent above `67108864` bytes before it enters the publication queue. `maxQueueBytes` controls approximate buffered binlog bytes and defaults to `16777216`; it must be at least `maxEventBytes`. A single accepted RowsEvent may occupy the queue by itself and is published one row at a time, while later buffered events remain subject to `maxQueueBytes`.

The Kafka service must allow every routed topic. MySQL must enable `log_bin=ON`, `binlog_format=ROW`, `binlog_row_image=FULL`, and `binlog_row_metadata=FULL`; transaction compression must be off and `binlog_row_value_options` empty. The account needs replication-client, replication-slave, and table metadata access.

## Startup, recovery, and health

Initialization queries `INFORMATION_SCHEMA` before starting replication. Every routed table must exist, its ordered MySQL primary key must exactly equal `primaryKey`, and all primary-key and excluded columns must exist. When no checkpoint exists, initialization queries the current binlog file and size, validates and durably records that numeric tail, and then starts replication from the explicit saved coordinate. Rows before that first checkpoint are not published, while changes committed after the tail query are replayed from it. Later starts resume the saved position. Schema fingerprints include column types, keys, character sets, collations, and enum/set values. A changed fingerprint enters `paused-schema` without advancing the checkpoint.

Every RowsEvent must report the table's complete column count and full columns-present bitmap; UPDATE requires complete before and after bitmaps. This detects a runtime switch to `MINIMAL` or `NOBLOB` row images before publication. Statement-based DML Query events, XA statements or prepare markers, transaction-compressed payloads, partial-JSON row updates, and unknown events fail closed. Schema-changing `CREATE` or `DROP` for a table, database, schema, or index, `ALTER TABLE|DATABASE|SCHEMA`, and `RENAME TABLE` are terminal even when they affect only unrelated objects. `TRUNCATE` of a routed table is terminal; an unrelated `TRUNCATE` may advance the checkpoint.

Recoverable MySQL failures during initial validation, initial reader startup, or runtime replication use the same retry policy; a runtime restart resumes the latest publish-safe checkpoint. Recoverable Kafka publication failures pause capture and retry the same record. `retryInitialDelayMs` and `retryMaxDelayMs` default to `1000` and `30000` and define exponential backoff; the initial delay cannot exceed the maximum. `maxRetries` is either a numeric retry limit per failure burst or the default `unlimited`. Configuration, schema, unsupported-event, data, and resource-limit failures are terminal rather than retried.

Host health code can inspect `status` (`starting`, `streaming`, `backpressured`, `retrying`, `paused-schema`, `failed`, or `stopped`) and `lastError`. It must supervise `done`: the promise resolves after successful disposal reaches quiescence and rejects only after an unexpected terminal or shutdown failure has stopped the reader and settled accepted queue work.

## Delivery

One changed row becomes one versioned JSON Kafka record. Its Kafka key is the configured compound primary key. `before` and `after` distinguish inserts, updates, and deletes. `changedColumns` lists every source column whose normalized value changed; inserts and deletes list all image columns. Older version-one records without this optional field remain readable because consumers can derive it from the row images. Large integers and decimals remain strings. MySQL temporal values remain exact strings in a UTC connection context, preserving fractional seconds and zero dates without JavaScript `Date` coercion; binary values use explicit `$binary` objects. Excluded values never enter row images or logs, although an excluded column name can appear in `changedColumns`. An update that changes a primary-key value stops capture because moving between Kafka key partitions would lose ordering.

Publishing is at least once. A transaction checkpoint is written only after all earlier Kafka publications succeed. An uncertain publication keeps the old checkpoint, so restart can duplicate events; consumers use the stable `eventId` or offset-aware primary-key projection semantics. Corrupt checkpoints, expired binlog positions, schema changes, primary-key changes, invalid or incomplete row metadata, unsupported query or row events, routed `TRUNCATE`, missing routes, oversized events, and bounded-queue overflow fail loudly without advancing past unpublished records.

## Model Experience

### MySQL CDC

#### What the model sees

`None`. The plugin has no model-facing output.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- One active instance owns one source and local checkpoint; HA fencing is absent.
- Historical snapshots, periodic reconciliation, exactly-once delivery, Kafka transactions, schema registry integration, and dead-letter tooling are deferred.
- Cross-table transaction atomicity is not preserved in Kafka.
- Primary-key value updates stop capture; use immutable keys or a later version-aware projection protocol.
- Downtime beyond MySQL binlog retention creates a gap that requires an external rebuild or reconciliation.
- `TRUNCATE TABLE` cannot produce row deletes and stops capture.
- XA transactions and statement-based DML are unsupported and stop capture.
- `maxBinlogEventBytes` is checked after ZongJi has read and decoded the RowsEvent, so it rejects publication and queue admission but cannot bound packet-parser peak memory.
