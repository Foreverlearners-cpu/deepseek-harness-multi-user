# @deepseek-ai/dsh-cdc-elasticsearch

[English](README.md) | 中文

仅限 Host 的 Kafka CDC 消费插件，把路由的 MySQL 行投影到 Elasticsearch。新增和修改以有界的源表与主键摘要文档 ID 写入 `after` 镜像；删除会移除文档，并容忍目标不存在。每行的顺序来自 MySQL binlog 源坐标，而不是 Kafka offset。

配置包括非空白且唯一的 `subscriptionId`、允许且非空白的 `consumerGroup`、非空且唯一的 `topics`、仅在 Kafka 没有已提交 offset 时使用的 `fallbackMode`、非空白且默认为 `dsh-cdc-state-v1` 的 `stateIndex`，以及表 `routes`；每条路由包含非空白的 `database`、`table`、一个已订阅的 `topic`、目标 `index` 和可选、唯一且非空白的 `watchedColumns`。`fallbackMode` 默认为 `latest`。每个已订阅 topic 至少要有一条路由。非空监听列表只在声明的变更字段至少包含一个指定字段时处理 UPDATE；INSERT 和 DELETE 始终处理。列表为空或省略时处理全部 UPDATE。缺少 `changedColumns` 的旧版 v1 UPDATE 会保守地完整应用。

## 顺序状态与交付

对于每个实际处理的行事件，消费者使用 binlog 文件数字后缀乘以 `2^32` 再加事件 position，得到一个精确的 `external_gte` 版本。Kafka offset 只以十进制字符串记录用于诊断，不参与顺序比较。状态文档 ID 对配置的目标 index、源 database 和 table 及主键取摘要；它刻意排除 consumer group、topic、partition 和 offset，因此 consumer group 变化或 Kafka partition 迁移仍会共享同一行的顺序状态。状态文档会记录 event ID、源坐标、topic、partition 和 offset。

消费者先按源版本写入状态文档，再使用同一版本写入或删除目标文档。只有 `409 version_conflict_engine_exception` 会被视为顺序冲突。首次写状态发生冲突，说明已经记录了更高源坐标，因此会确认过期事件而不操作目标。目标写入冲突后，消费者会再次写入状态：此时冲突证明已有更高源坐标取代该事件，可以确认；如果相同版本的状态写入成功，则传播原始目标冲突，并让 Kafka 记录保持未提交以便重试。其他 409 错误都会传播。由于 `external_gte` 接受相同版本，重放可以补写在状态成功后失败的目标操作。

`stateIndex` 是正确性 metadata，而不是业务数据。使用运维凭据把它预建为稳定的具体 index，永久保留每份状态文档，并排除业务 ILM、删除、rollover 和 data stream；正确性不依赖目标 index 的删除墓碑。预建后，运行时身份只需具备状态 index 的最小文档写权限和路由目标的写入、删除权限，无需 auto-create 或 index 管理权限。其他应用不得写入状态 index。它的具体 backing index 不得作为路由目标，状态名称或任何目标 alias 也不得解析到对方的 backing index；插件只会拒绝配置名称直接相同的情况，因此 alias 和 backing-index 隔离必须由部署保证。

消费者要求 Kafka 二进制 key 与 CDC 事件 key 一致，并要求每个 key 字段都与所有可用行镜像一致。Redis 与 Elasticsearch 消费者需要不同 group。Kafka 会提交已过滤的记录、由状态 index 证明源坐标过期或已被取代的记录、不存在的删除目标以及成功的目标写入。

插件会监督 Kafka 订阅。运行期失败后，它先关闭失败句柄，再按指数退避等待，等待时间从默认 `1000` 的 `retryInitialDelayMs` 增长到默认 `30000` 的 `retryMaxDelayMs`，随后以相同标识重新订阅。成功处理一条记录会重置退避。`maxRetries` 可以是连续重试次数上限，也可以使用明确的默认值 `unlimited`；数字上限耗尽后会记录 error 并卸载插件。插件销毁会取消待执行的退避并等待活动订阅关闭。

## Model Experience

### Elasticsearch CDC projection

#### What the model sees

`无`。该插件没有模型可见输出。

#### Token effect

每次请求直接增加零 token。

#### KV Cache effect

与模型请求无关。

## Known Limitations and Deferred Work

- 状态写入、目标写入和 Kafka offset 提交不是原子操作；确定性 ID、永久状态和相同版本重试会让保留期内的重放保持幂等，并补写中断的目标操作。
- 源顺序假设同一 MySQL lineage 的 binlog 文件数字后缀单调递增。执行 `RESET MASTER`、切换主库、恢复备份或任何 binlog 序号回退后，必须使用全新 `stateIndex`，并在恢复消费前清空或重建所有受影响目标。只更换状态 index 会让现有目标文档保留不兼容的 external version。
- Binlog 数字后缀和 position 必须生成从 `1` 到 `Number.MAX_SAFE_INTEGER` 的精确外部版本；文件名无效或坐标超出范围时会失败，而不会舍入。Kafka offset 保持为字符串，因此不受该限制。
- 旁路目标写入方不得写入更高的 external version。目标版本领先于 CDC 状态时会产生有意保留的冲突，操作失败并重试，而不会被误判为过期；恢复需要协调修复或重建目标。
- 目标 index template、mapping、alias、refresh policy、bulk delivery、重建和对账仍由部署方负责。状态 index 的非滚动预建与永久保留是强制的部署职责。
- 毒消息会阻塞其 Kafka partition，并在达到数字重试上限前持续重试；使用 `unlimited` 时会无限重试。retry topic 和 dead-letter 处理延后。
