# Agent Note: Conversation 语义记录服务

Status: implemented

[English](2026-08-25-conversation-semantic-record-service.md) | 中文

## Problem

一个 Agent 回合可能产生数百条有意义的工具、审批、子 Agent、文件和消息事实，同时模型流式生成还会产生大量瞬时 chunk。产品历史与恢复需要带 tenant ownership 和稳定顺序的完整业务记录，但保存 chunk 不会改善业务恢复点，只会扩大业务存储。

运行时 Session header 不包含 tenant 或 user ownership，恢复种子事件也不会再次发出。因此语义投影不能只从后续 live event 推断持久 owner。Provider 重试还同时需要业务排序 key 和原始 Session 位置。

## Decision

`@deepseek-ai/dsh-conversation` 是 Conversation 元数据、完整 `AgentRecord`、消息投影和子 Agent 关系的 Provider-independent Service Definition。它只依赖 Cordis、branded id 和运行时 invariant；存储与传输包保持在外部。

根 Session 在首条业务记录前显式绑定 tenant 和 user ownership。子 Session 可以通过已绑定父 Session 建立 attachment，并继承相同 owner。由于 Session 恢复不会重放 `session/event`，恢复 Consumer 会扫描已恢复 Session，并在处理后续事件之前完成绑定。

每条语义记录包含 Provider 分配的连续 `sequence` 和原始 Session `sourceSequence`。原子 append 比较 `expectedNextSequence`；完全相同的重试保持幂等，冲突的过期范围会失败。查询 cursor 是不透明值，由 Provider 绑定到 tenant、user、Conversation 和筛选条件。

第一版记录 union 包含完整用户与助手消息、不含部分文本的助手中断 attempt 元数据、工具调用与结果、审批、子 Agent 生命周期、文件发布和回合完成。Chunk、reasoning delta、argument delta、传输、心跳和瞬时进度事件被排除。`assistant/interrupted` 从中断回合边界派生，不增加核心 Session 事件。

除非显式版本化 tenant policy 提供归档或删除时间，否则 Conversation 永久保留。授权继续由 Consumer 负责。

## Alternatives considered

**把每个 Session 事件保存为业务记录。** 这会保留产品恢复不使用的流式细节，并把业务 schema 耦合到运行时事件粒度。Session persistence 继续负责无损日志。

**从首条消息推断 ownership。** Session 可能从工具开始，恢复不会重发种子事件，子 Session 也需要在任何记录之前确定 owner。显式 attachment 把安全关系作为权威操作的输入。

**只使用原始 Session sequence。** 一个 source event 可能不产生语义记录，后续也可能需要投影为多条记录。独立业务 sequence 和 source sequence 同时保留连续产品顺序与 source 幂等性。

**中断时保存部分助手文本。** 部分文本不是完整产品消息，也可能暴露用户从未收到的最终内容。记录只保留 attempt 身份和安全失败元数据。

## Consequences

Provider 共享一组类型化操作和一个可复用一致性测试套件。后续批处理与 MySQL 包可以实现 tenant 隔离、完全相同重试、keyset 分页和按条恢复，而不接收 chunk 数据。

显式 attachment 在语义写入前增加一个必要生命周期操作，恢复 Consumer 必须扫描已恢复 Session。Service Definition 本身不映射 Session 事件、不调度持久化、不授权用户、不保存文件，也不提供生产后端。
