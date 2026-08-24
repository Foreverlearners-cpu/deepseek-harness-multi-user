# @deepseek-ai/dsh-cdc-protocol

[English](README.md) | 中文

版本一 CDC 行事件的传输无关类型和严格 codec。生产方与消费方可以共享协议格式（wire format），而无需导入 MySQL driver、binlog reader、Cordis service 或 Kafka transport 代码。

## 协议格式

`CdcEvent` 通过 `eventId`、规范 UTC `occurredAt`、MySQL 源坐标、非空复合 `key`、行镜像、可选 `changedColumns` 和 `schemaFingerprint` 标识一次 `insert`、`update` 或 `delete`。insert 事件只携带 `after`，update 事件携带两个镜像，delete 事件只携带 `before`。`CdcCheckpoint` 描述版本一生产方恢复坐标，但本包不读写 checkpoint 存储。

`encodeCdcEvent()` 在发布前校验类型化输入。`decodeCdcEvent()` 把字节视为不可信输入：它拒绝空或超大 payload、错误 UTF-8、无效 JSON、不支持的 `specVersion`、未知顶层或源字段、无效值、不一致的行镜像和不完整的 `changedColumns`。两个函数都接受更小的 `maxBytes`；codec 的绝对上限是 `MAX_CDC_WIRE_BYTES`（64 MiB）。失败是带稳定 `code` 值的 `CdcWireError`，其诊断绝不包含行内容。

`encodeKey()` 保留 JavaScript property 插入顺序，因此生产方必须按配置的主键顺序构建复合 key。`findChangedColumns()` 对 JSON 值进行深度比较，`getChangedColumns()` 则保留显式的版本一列表，并为缺少该列表的旧版版本一记录推导列表。

## Model Experience

### CDC protocol

#### What the model sees

`None`。本包没有面向模型的输出。

#### Token effect

每次请求直接产生零 token。

#### KV Cache effect

与模型请求无关。

## Known Limitations and Deferred Work

- 版本一对 MySQL binlog 坐标和完整行镜像建模；其他源坐标系统需要后续协议版本。
- codec 没有 schema registry，也不证明 `schemaFingerprint` 与实时数据库 schema 一致。
- JavaScript parser 选定最终值之后，JSON 解析无法检测重复的对象成员名。
