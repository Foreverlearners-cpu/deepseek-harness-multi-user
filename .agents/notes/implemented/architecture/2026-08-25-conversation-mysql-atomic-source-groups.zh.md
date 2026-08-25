# Agent Note: MySQL Conversation 原子 source group

Status: implemented

[English](2026-08-25-conversation-mysql-atomic-source-groups.md) | 中文

## 问题

一个 Session source event 可以投影为多条相邻语义 records。如果把 `sourceSequence` 当作全局唯一值，会丢失有效 records；如果独立重试每条 record，则可能只接受 source event 的一部分。当任意写入失败时，Conversation 元数据、用户可见 messages 和 subagent 状态也必须保持一致。

## 决策

`@deepseek-ai/dsh-conversation-mysql` 锁定一条 owner-scoped conversation 行，并在一个事务中写入完整 append。records 以 conversation sequence 作为主顺序，并通过 `(tenant, user, session, sourceSequence, recordId)` 保证唯一，因此相邻 records 可以共享一个 source。每个 source group 都保存基于 canonical 完整 records 计算的相同 SHA-256。只有每个请求行和 group hash 都匹配时重试才成功；部分或已改变的重试会失败。

record 和 message 行使用最多 64 行的多值语句，同时一个外层事务覆盖所有语句、投影和 conversation 推进。message 身份保持为 `(tenant, user, session, message)`，面向 CDC 的 message 表只暴露现有 Consumer 接受的十个字段；仅供查询使用的 ordinal 和 extensions 位于独立内部状态表。message 投影与其 source records 一起提交。没有 started run 的 subagent completion 会中止同一事务。

Provider 保存 canonical UTC 时间戳和永久保留策略。每个查询都包含 tenant 与 user 所有权，并使用与过滤条件绑定的 keyset cursor。schema 创建使用服务端 advisory lock，并且只在所有 Provider 自有表都存在后记录版本。

## 备选方案

**唯一 source sequence。** 这会阻止一个 Session event 合法产生 interrupted-attempt 与 turn-completion records 对。

**每个 SQL batch 使用一个事务。** 这可以缩短事务时间，但可能暴露 source append 的前缀，并让投影和 records 分开推进。

**使用 INSERT IGNORE 实现幂等。** 它无法区分精确重试、内容改变或部分 source group，因此会隐藏冲突。

**由 CDC 拥有表。** Conversation persistence 拥有关系型事实；CDC 只是可选的下游发布机制，不应定义这些表或事务。

## 结果

精确重试和崩溃会保留完整 source group 与同步投影。大 append 使用多条有界 SQL 语句，但保持一个事务和行锁，因此事务持续时间会增加。canonical hashing 消耗 CPU；永久保留还需要本 Provider 之外后续实现 owner-aware 归档或垃圾回收。
