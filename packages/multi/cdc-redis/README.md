# @deepseek-ai/dsh-cdc-redis

English | [中文](README.zh.md)

Host-only Kafka CDC consumer that projects each routed MySQL row into Redis. Inserts and updates overwrite one JSON value under a bounded source-table-and-primary-key digest; deletes remove it. A positive per-route `ttlSeconds` applies an expiry and cannot exceed one year. The JSON value format is unchanged by ordering protection.

Configuration supplies a non-blank unique `subscriptionId`, an allowed non-blank `consumerGroup`, non-empty unique `topics`, a `fallbackMode` used only when Kafka has no committed offset, and table `routes` containing non-blank `database`, `table`, one subscribed `topic`, `keyPrefix`, optional `ttlSeconds`, and optional unique non-blank `watchedColumns`. `fallbackMode` defaults to `latest`. Every subscribed topic must have at least one route. A non-empty watch list applies an UPDATE only when at least one declared changed column is watched; INSERT and DELETE always apply. An empty or omitted list applies every update. Older version-one UPDATE events without `changedColumns` are conservatively applied in full.

The consumer requires the binary Kafka key to equal the CDC event key and requires every key field to match each available row image. It stores topic, partition, and decimal Kafka offset in a persistent companion hash ending in `:__dsh_cdc_version`; one Lua operation rejects partition movement, skips duplicate or older offsets, updates the version, and changes the JSON value atomically. `commandTimeoutMs` defaults to `10000` and aborts an overdue Redis command. Use a consumer group distinct from every other projection so Redis and Elasticsearch each receive all events. Kafka commits filtered, duplicate, and successfully applied records.

The plugin supervises the Kafka subscription. After a runtime failure it closes the failed handle, waits from `retryInitialDelayMs` (default `1000`) up to `retryMaxDelayMs` (default `30000`) with exponential backoff, and subscribes again with the same identity. A successfully handled record resets the backoff. `maxRetries` is either a numeric consecutive retry limit or the explicit default `unlimited`; exhausting a numeric limit logs an error and unloads the plugin. Plugin disposal cancels pending backoff and waits for the active subscription to close.

## Model Experience

### Redis CDC projection

#### What the model sees

`None`. The plugin has no model-facing output.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- Projection writes and Kafka offset commits are not atomic; persistent offset metadata makes a replay idempotent while that metadata exists.
- A route's Kafka topic must retain its partition count and partitioner. Moving one row key to another topic or partition stops that partition's handler and enters retry; topic recreation or manual metadata deletion removes ordering continuity.
- Version hashes persist after deletes and data TTL expiry. Deployment-owned cleanup must coordinate with replay and reconciliation so an older event cannot recreate stale data.
- A poison event blocks its Kafka partition and is retried until the numeric retry limit is exhausted or indefinitely under `unlimited`; retry topics and dead-letter handling are deferred.
- Cache rebuild, reconciliation, custom Redis data structures, and partial-value writes are deferred.
