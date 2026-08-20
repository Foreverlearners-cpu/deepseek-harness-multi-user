# @deepseek-ai/dsh-cdc-elasticsearch

English | [中文](README.zh.md)

Host-only Kafka CDC consumer that projects routed MySQL rows into Elasticsearch. Inserts and updates index the `after` image under a bounded source-table-and-primary-key document id; deletes remove that document and tolerate an absent target. Per-row ordering comes from the MySQL binlog source coordinate rather than the Kafka offset.

Configuration supplies a non-blank unique `subscriptionId`, an allowed non-blank `consumerGroup`, non-empty unique `topics`, a `fallbackMode` used only when Kafka has no committed offset, a non-blank `stateIndex` that defaults to `dsh-cdc-state-v1`, and table `routes` containing non-blank `database`, `table`, one subscribed `topic`, destination `index`, and optional unique non-blank `watchedColumns`. `fallbackMode` defaults to `latest`. Every subscribed topic must have at least one route. A non-empty watch list applies an UPDATE only when at least one declared changed column is watched; INSERT and DELETE always apply. An empty or omitted list applies every update. Older version-one UPDATE events without `changedColumns` are conservatively applied in full.

## Ordering state and delivery

For each applied row event, the consumer derives one exact `external_gte` version as the binlog file's numeric suffix multiplied by `2^32`, plus the event position. Kafka offsets are recorded as decimal strings for diagnostics and do not participate in ordering. The state document id hashes the configured target index, source database and table, and primary key; it intentionally excludes the consumer group, topic, partition, and offset, so consumer-group changes or Kafka partition movement continue to share the same per-row ordering state. The state document records the event id, source coordinate, topic, partition, and offset.

The consumer first indexes the state document with the source version and then writes or deletes the target document with that same version. Only a `409 version_conflict_engine_exception` is treated as an ordering conflict. A conflict on the initial state write proves that a higher source coordinate is already recorded, so the stale event is acknowledged without touching the target. After a target conflict, the consumer repeats the state write: a conflict there proves that a higher source coordinate superseded the event and it is acknowledged; if the equal-version state write succeeds, the original target conflict propagates and the Kafka record remains uncommitted for retry. Other 409 errors propagate. Because `external_gte` admits an equal version, replay can repair a target write that failed after its state write succeeded.

The `stateIndex` is correctness metadata, not business data. Pre-create it as a stable concrete index with operator credentials, retain every state document permanently, and exclude it from business ILM, deletion, rollover, and data streams; correctness does not depend on target-index delete tombstones. Pre-creation lets the runtime principal use least-privilege document-write access to the state index and write/delete access to route targets without auto-create or index-management privileges. No other application may write the state index. Its concrete backing index must not be a route target, and neither the state name nor any target alias may resolve to the other's backing indices; the plugin rejects only directly equal configured names, so deployment must enforce alias and backing-index separation.

The consumer requires the binary Kafka key to equal the CDC event key and requires every key field to match each available row image. Redis and Elasticsearch consumers need distinct groups. Kafka commits filtered records, source-stale or superseded records proven by the state index, absent deletes, and successful target writes.

The plugin supervises the Kafka subscription. After a runtime failure it closes the failed handle, waits from `retryInitialDelayMs` (default `1000`) up to `retryMaxDelayMs` (default `30000`) with exponential backoff, and subscribes again with the same identity. A successfully handled record resets the backoff. `maxRetries` is either a numeric consecutive retry limit or the explicit default `unlimited`; exhausting a numeric limit logs an error and unloads the plugin. Plugin disposal cancels pending backoff and waits for the active subscription to close.

## Model Experience

### Elasticsearch CDC projection

#### What the model sees

`None`. The plugin has no model-facing output.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- State, target, and Kafka offset commits are not atomic; deterministic ids, permanent state, and equal-version retries make retained replay idempotent and repair an interrupted target write.
- Source ordering assumes the numeric binlog file suffix is monotonic for one MySQL lineage. `RESET MASTER`, a primary change, a restore, or any binlog sequence rollback requires a fresh `stateIndex` and clearing or rebuilding every affected target before consumption resumes. Changing only the state index leaves incompatible external versions on existing target documents.
- The numeric binlog suffix and position must produce an exact external version from `1` through `Number.MAX_SAFE_INTEGER`; invalid file names or coordinates outside that range fail instead of being rounded. Kafka offsets are not subject to this limit because they remain strings.
- Out-of-band target writers must not install a higher external version. A target version ahead of the CDC state causes a deliberate conflict that fails and retries rather than being misclassified as stale; recovery requires coordinated target repair or rebuild.
- Target index templates, mappings, aliases, refresh policy, bulk delivery, rebuild, and reconciliation remain deployment-owned. The state index's non-rolling provisioning and retention are mandatory deployment responsibilities.
- A poison event blocks its Kafka partition and is retried until the numeric retry limit is exhausted or indefinitely under `unlimited`; retry topics and dead-letter handling are deferred.
