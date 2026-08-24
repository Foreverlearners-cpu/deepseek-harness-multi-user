# Agent Note: CDC 协议格式所有权

Status: implemented

[English](2026-08-23-cdc-wire-protocol-ownership.md) | 中文

## Problem

MySQL 采集插件同时拥有数据库专用复制逻辑，以及 Kafka 消费方导入的事件类型与 decoder。消费方因此仅为校验传输字节就依赖 MySQL、ZongJi 和 Cordis service 包装；decoder 还会接受由错误 UTF-8 产生的替换字符，并且没有独立 payload 上限或稳定错误类别。

## Decision

`@deepseek-ai/dsh-cdc-protocol` 拥有 `CdcEvent`、`CdcCheckpoint`、配套类型、复合 key 编码、变更字段推导以及版本一事件 codec。它的主入口不依赖 Cordis、Kafka、MySQL 或 ZongJi。仓库要求的 package invariant 是空操作伴随入口，不会进入协议依赖图。

`decodeCdcEvent()` 在解码前校验字节上限，使用 fatal UTF-8 解码，解析 JSON，单独拒绝不支持的版本，然后校验准确的事件与源字段、JSON-safe 值、operation 专用行镜像、规范 timestamp、复合 key 和变更字段覆盖。`encodeCdcEvent()` 在返回可发布字节前执行相同的事件校验和字节上限校验。错误使用与 payload 内容无关的消息和稳定的 `CdcWireError.code` 值。

`@deepseek-ai/dsh-cdc` 从协议包导入采集所需内容，并重导出现有 CDC 类型和 helper。现有 Redis 与 Elasticsearch 消费方因此保留其 import，新消费方则可以依赖协议包而不引入采集 driver。

## Compatibility

版本一保留现有字段名和可选 `changedColumns` 规则。新增顶层或源字段需要新的 `specVersion`；旧消费方会据此拒绝无法解释的事件，而不会静默忽略生产方语义。64 MiB 绝对 codec 上限与采集包的已解码 binlog event 安全尺度一致，调用方可以施加更小的部署上限。

## Alternatives considered

**把 codec 保留在 `dsh-cdc`。** 这种选择保留单一包，但会迫使每个协议消费方依赖数据库采集实现，也让生产方与消费方难以独立开发。

**把 MySQL 归一化和 checkpoint I/O 移入协议包。** 这些操作属于采集职责：归一化接受 driver 解码的运行时值，而 checkpoint 发布拥有文件系统持久性。移动它们会让协议包只有名义上的传输无关性。

**在版本一中接受未知字段。** 这种选择让增量变更更容易，但允许生产方附加旧消费方静默丢弃的语义。显式修改版本能让兼容性评审成为有意决策。

## Consequences

生产方与消费方共享一个严格且依赖较轻的协议包，错误消息会在 handler 逻辑看到它们之前失败。采集包通过兼容重导出保留其公开 import。准确字段校验让版本演进显式化，fatal 解码会拒绝宽松 UTF-8 转换过去替换的字节。codec 无法使用平台 JSON parser 检测重复 JSON 成员名，schema fingerprint 仍需要采集方和消费方拥有的 schema 检查。
