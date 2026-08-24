# @deepseek-ai/dsh-cdc-redis

[English](README.md) | 中文

仅限 Host 的 Kafka CDC 消费插件，把每个路由的 MySQL 行投影到 Redis。新增和修改按有界的源表与主键摘要覆盖一份 JSON 值；删除会移除该 key。每条路由可通过正数 `ttlSeconds` 设置过期时间，上限为一年。顺序保护不会改变 JSON 值格式。

配置包括非空白且唯一的 `subscriptionId`、允许且非空白的 `consumerGroup`、非空且唯一的 `topics`、仅在 Kafka 没有已提交 offset 时使用的 `fallbackMode`，以及表 `routes`；每条路由包含非空白的 `database`、`table`、一个已订阅的 `topic`、`keyPrefix`、可选 `ttlSeconds` 和可选、唯一且非空白的 `watchedColumns`。`fallbackMode` 默认为 `latest`。每个已订阅 topic 至少要有一条路由。非空监听列表只在声明的变更字段至少包含一个指定字段时处理 UPDATE；INSERT 和 DELETE 始终处理。列表为空或省略时处理全部 UPDATE。缺少 `changedColumns` 的旧版 v1 UPDATE 会保守地完整应用。

消费者要求 Kafka 二进制 key 与 CDC 事件 key 一致，并要求每个 key 字段都与所有可用行镜像一致。它在以 `:__dsh_cdc_version` 结尾的持久伴随 hash 中保存 topic、partition 和十进制 Kafka offset；单次 Lua 操作会拒绝 partition 迁移、跳过重复或更旧的 offset，并原子更新版本和 JSON 值。`commandTimeoutMs` 默认为 `10000`，并会中止超时的 Redis 命令。Redis 与 Elasticsearch 必须使用不同 consumer group，才能各自收到全部事件。Kafka 会提交已过滤、重复或成功应用的记录。

插件会监督 Kafka 订阅。运行期失败后，它先关闭失败句柄，再按指数退避等待，等待时间从默认 `1000` 的 `retryInitialDelayMs` 增长到默认 `30000` 的 `retryMaxDelayMs`，随后以相同标识重新订阅。成功处理一条记录会重置退避。`maxRetries` 可以是连续重试次数上限，也可以使用明确的默认值 `unlimited`；数字上限耗尽后会记录 error 并卸载插件。插件销毁会取消待执行的退避并等待活动订阅关闭。

## Model Experience

### Redis CDC projection

#### What the model sees

`无`。该插件没有模型可见输出。

#### Token effect

每次请求直接增加零 token。

#### KV Cache effect

与模型请求无关。

## Known Limitations and Deferred Work

- 投影写入和 Kafka offset 提交不是原子操作；只要持久 offset 元数据仍存在，重放就是幂等的。
- 路由对应的 Kafka topic 必须保持 partition 数量和分区器不变。某个行 key 移至其他 topic 或 partition 时，该 partition 的处理会失败并进入重试；重建 topic 或手工删除元数据会丢失顺序连续性。
- 版本 hash 在 DELETE 和数据 TTL 到期后仍会保留。部署侧清理必须与重放和对账协调，避免旧事件重新创建过期数据。
- 毒消息会阻塞其 Kafka partition，并在达到数字重试上限前持续重试；使用 `unlimited` 时会无限重试。retry topic 和 dead-letter 处理延后。
- 缓存重建、对账、自定义 Redis 数据结构和局部值写入延后。
