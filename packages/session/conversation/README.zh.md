# @deepseek-ai/dsh-conversation

[English](README.md) | 中文

与 Provider 无关的 Host 服务，定义租户所属 Conversation、完整 Agent 语义记录、界面消息投影和父子 Agent 运行关系。它规定存储义务，但不选择 MySQL、Redis、Kafka 或文件后端。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.conversations.attach(input)` | 首条业务记录之前，把运行时 Session 绑定到 tenant/user；子 Session 可以从已绑定父 Session 继承 owner |
| `ctx.conversations.create(input)` | 为导入或管理流程显式创建 Conversation 元数据 |
| `ctx.conversations.get(identity)` | 读取当前 tenant-scoped 元数据 |
| `ctx.conversations.append(request)` | 在 `expectedNextSequence` 原子追加非空连续记录范围 |
| `ctx.conversations.list(query)` | 使用不透明 keyset cursor 列出 tenant-user Conversation |
| `ctx.conversations.records(query)` | 按业务 sequence 列出完整语义记录 |
| `ctx.conversations.messages(query)` | 列出完整用户与助手消息投影 |
| `ctx.conversations.subagents(query)` | 列出直接子 Agent 委派，不复制子 Agent transcript |

每个身份都显式限定 tenant 和 user。根 Session 在首条业务记录前通过 `attach()` 提供两个身份。子 Session 提供已经绑定的父 Session，并继承该 owner。重复相同绑定是幂等操作；改变 Session 绑定会冲突。恢复代码打开已存储 Session 时必须在初始扫描中绑定，因为恢复种子事件不会再次发出。

## 语义记录

`AgentRecord` 同时包含 Provider 分配的连续 `sequence` 和原始 Session `sourceSequence`。`sequence` 表示业务顺序；`sourceSequence` 让投影扫描或重试 Session 事件时拥有稳定 source identity。相同记录身份和内容的重试是幂等操作；使用过期 `expectedNextSequence` 写入不同范围会失败。

第一版封闭类型为 `user/message`、`assistant/message`、`assistant/interrupted`、`tool/call`、`tool/result`、`approval/asked`、`approval/decided`、`subagent/started`、`subagent/completed`、`file/published` 和 `turn/completed`。每一项都是完整的小记录。`assistant/chunk`、reasoning delta、工具参数 delta、传输帧、心跳和瞬时进度不属于本服务。

`assistant/interrupted` 包含 attempt 身份、可选安全错误码和可选已生成字符数，不包含部分助手文本。后续投影从 interrupted、aborted 或 failed 的回合边界派生该记录，而不是向核心 Session 增加事件。

Conversation 保留策略默认为 `{ kind: 'permanent' }`。tenant policy 可以提供 policy revision 和可选归档或删除时间。配置或应用该策略的授权不属于本服务。

## 实现 Provider

Provider 继承 `ConversationService`，实现绑定、创建、原子追加和四个查询操作。它必须在权威操作中执行 tenant/user ownership，原子分配或验证连续 sequence 范围，使完全相同的 append 重试保持幂等，并把每个不透明 cursor 绑定到完整查询 scope 和筛选条件。

`tests/contract.ts` 中的共享套件是 Provider 规范测试。仓库内 Provider 使用全新空存储介质运行 `runConversationContract()`，并增加后端特有的并发、事务、schema 和重启测试。

## 失败语义

`ConversationError` 提供 `invalid-input`、`conversation-not-found`、`conversation-conflict`、`sequence-conflict`、`record-conflict` 和 `provider-unavailable`。Provider 诊断、SQL、Credential、记录 payload 和文件路径不能进入 transport-safe 失败信息。

## 模型体验

### 语义持久化

#### 模型看到什么

不会直接看到任何内容。本包不注册工具、prompt section、模型消息或 Session 事件。Consumer 可以持久化其他模型输入代码已经记录的事实。

#### Token 影响

为零。服务调用不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。持久化或查询语义记录不会改变模型可见请求前缀。

## 已知限制与延期工作

- **没有生产 Provider** - MySQL schema、事务、keyset 编码、批处理、重试和 flush 属于后续 Provider 与持久化策略包。
- **没有 Session 事件 mapper** - 本包定义语义目标；后续 Consumer 映射完整 Session 事实并忽略 chunk 级事件。
- **没有存储策略** - 计划中的 256 KiB 工具结果 spill 阈值、队列边界和 flush 时点不属于该 Service Definition。
- **没有授权** - attachment 或查询之前必须先建立已认证 tenant 与 user 上下文。
- **没有文件字节** - `file/published` 只携带稳定引用；文件生命周期和字节属于文件存储 Provider。
