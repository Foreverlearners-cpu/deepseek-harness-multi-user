# @deepseek-ai/dsh-cdc

[English](README.md) | 中文

仅限 Host 的 MySQL 行变更采集插件。没有 checkpoint 时从当前 binlog 尾部开始；插件把配置表的 `INSERT`、`UPDATE`、`DELETE` 行镜像发布到 Kafka，并在重启后从原子写入的本地 checkpoint 继续。它不会复制历史数据。

## 配置

`host`、`user`、`password` 和唯一的复制 `serverId` 用于选择 MySQL；`port` 和 `connectTimeoutMs` 默认分别为 `3306`、`10000`。`checkpointFile` 必须指向持久的本地存储。每个 `routes` 项定义 `database`、`table`、Kafka `topic`、有序且非空的 `primaryKey` 和可选 `excludeColumns`。主键字段不能被排除，配置的每个主键字段和排除字段都必须与 MySQL metadata 准确匹配。

`maxEventBytes` 限制单条序列化行记录，默认为 `1048576`。`maxBinlogEventBytes` 会在已解码的 MySQL RowsEvent 进入发布队列前拒绝超过 `67108864` 字节的事件。`maxQueueBytes` 控制缓冲 binlog 的近似字节数，默认为 `16777216`，且不得小于 `maxEventBytes`。单个已接受 RowsEvent 可以独占队列并逐行发布，随后缓冲的事件仍受 `maxQueueBytes` 限制。

Kafka 服务必须允许所有路由 topic。MySQL 必须启用 `log_bin=ON`、`binlog_format=ROW`、`binlog_row_image=FULL` 和 `binlog_row_metadata=FULL`；transaction compression 必须关闭，`binlog_row_value_options` 必须为空。账号需要 replication client、replication slave 和表元数据访问权限。

## 启动、恢复与健康状态

初始化会在启动 replication 前查询 `INFORMATION_SCHEMA`。每个路由表都必须存在，MySQL 中的有序主键必须与 `primaryKey` 完全相同，而且所有主键字段和排除字段都必须存在。没有检查点时，初始化会查询当前 binlog 文件及大小，校验并持久记录数值形式的尾点，再从这个明确保存的坐标启动 replication。首个检查点之前的行不会发布，尾点查询之后提交的变更则会从该坐标重放。后续启动从保存的位点恢复。schema 指纹包含字段类型、key、字符集、collation 及 enum/set 值；指纹变化会进入 `paused-schema`，且不会推进检查点。

每个 RowsEvent 都必须报告完整的表字段数和 columns-present bitmap；UPDATE 的 before、after bitmap 都必须完整。这样可以在发布前发现运行期切换到 `MINIMAL` 或 `NOBLOB` row image。Statement-based DML Query 事件、XA 语句或 prepare marker、压缩事务 payload、partial-JSON 行更新和 unknown 事件都会以失败方式关闭。针对 table、database、schema 或 index 的 schema-changing `CREATE`、`DROP`，以及 `ALTER TABLE|DATABASE|SCHEMA`、`RENAME TABLE` 都会终止采集，即使只影响无关对象也不例外。路由表的 `TRUNCATE` 会终止采集；无关表的 `TRUNCATE` 可以推进检查点。

初次校验、初次 reader 启动或运行期 replication 中的可恢复 MySQL 故障都使用同一重试策略；运行期重启会恢复到最新的发布安全检查点。可恢复的 Kafka 发布故障会暂停采集并重试同一记录。`retryInitialDelayMs` 和 `retryMaxDelayMs` 默认分别为 `1000`、`30000`，用于定义指数退避，且初始延迟不能大于最大延迟。`maxRetries` 可以是每次连续故障的数字重试上限，也可以使用默认值 `unlimited`。配置、schema、不支持事件、数据和资源限制错误属于终止故障，不会重试。

Host 健康检查代码可以读取 `status`（`starting`、`streaming`、`backpressured`、`retrying`、`paused-schema`、`failed` 或 `stopped`）和 `lastError`，并且必须监督 `done`。该 promise 会在成功 dispose 并完全停稳后 resolve；意外终止或关闭失败时，只会在 reader 停止且已接纳队列工作完成结算后 reject。

## 交付语义

每一行变更生成一条带版本的 JSON Kafka 记录。Kafka key 是配置的复合主键。`before` 和 `after` 区分新增、修改和删除。`changedColumns` 列出归一化值发生变化的所有源字段；新增和删除会列出镜像中的全部字段。没有这个可选字段的旧版 v1 消息仍可读取，消费方会从行镜像推导。大整数和 decimal 保持字符串。MySQL 时间值在 UTC 连接上下文中保持准确字符串，不经过 JavaScript `Date` 强制转换，因此能保留小数秒和零日期；二进制值使用显式 `$binary` 对象。被排除字段的值不会进入行镜像或日志，但字段名可以出现在 `changedColumns` 中。修改主键值会使采集停止，因为事件迁移 Kafka key 分区后会失去顺序保证。

发布语义为至少一次。只有更早的 Kafka 发布全部成功后才写入事务检查点。结果不确定的发布会保留旧检查点，因此重启可能产生重复；消费方应使用稳定 `eventId` 或可感知 offset 的主键投影语义。损坏的检查点、已过期的 binlog 位点、schema 变化、主键变化、无效或不完整的行 metadata、不支持的 query 或 row 事件、路由表 `TRUNCATE`、缺失路由、超大事件和有界队列溢出都会明确失败，且不会越过未发布记录推进。

## Model Experience

### MySQL CDC

#### What the model sees

`无`。该插件没有模型可见输出。

#### Token effect

每次请求直接增加零 token。

#### KV Cache effect

与模型请求无关。

## Known Limitations and Deferred Work

- 一个活跃实例拥有一个数据源和本地 checkpoint；尚无 HA fencing。
- 历史 snapshot、定时对账、exactly-once、Kafka transaction、schema registry 集成和 dead-letter 工具均延后。
- Kafka 中不保留跨表事务原子性。
- 主键值修改会停止采集；应使用不可变主键，或后续加入能比较版本的 projection protocol。
- 停机超过 MySQL binlog 保留期会产生缺口，需要外部重建或对账。
- `TRUNCATE TABLE` 无法生成逐行删除事件，会停止采集。
- 不支持 XA transaction 和 statement-based DML；遇到它们会停止采集。
- `maxBinlogEventBytes` 在 ZongJi 读取并解码 RowsEvent 后才检查，因此可以拒绝发布和队列接纳，但不能限制 packet parser 的内存峰值。
