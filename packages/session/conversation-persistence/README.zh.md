# @deepseek-ai/dsh-conversation-persistence

[English](README.md) | 中文

把运行时 Session 中已经完成的事件投影为 `@deepseek-ai/dsh-conversation` 语义记录。它不保存流式 chunk，也不修改 Session 日志，并对 Provider 写入提供有界缓冲。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `maxDelayMs` | `500` | 从第一条待写记录开始计算的固定窗口 |
| `maxBatchRecords` | `64` | 触发写入的记录数，也是单批最大记录数，但不可拆分的 source group 除外 |
| `maxBatchBytes` | `524288` | 按完整记录 UTF-8 大小触发写入，也是单批最大字节数；单个超限 source group 会独立写入 |
| `maxPendingRecords` | `4096` | 每个 Session 的记录上限，包含正在写入的记录 |
| `toolEffects` | `{}` | 工具名到 `read-only` 或 `external-side-effect` 的精确映射 |

## 注入与使用

先挂载 `ConversationService` Provider、`SessionStore` 和本插件。在创建 Session 之前注册工具副作用策略与扩展事件投影器，然后在第一条语义事件出现前绑定 Session：

```ts
ctx.effect(() => ctx.conversationPersistence.registerToolEffectClassifier(request => {
  if (request.toolName.startsWith('read_')) return 'read-only'
  if (request.toolName.startsWith('write_')) return 'external-side-effect'
  return undefined
}))

const session = ctx.sessions.create()
await ctx.conversationPersistence.attach(session, {
  tenantId,
  userId,
  conversationId,
  sessionId: conversationSessionId(session.id),
  origin: 'top-level',
  delegationDepth: 0,
})
```

未知工具不会被默认为只读，而是导致接纳失败。插件自有的必需 Session 事件通过 `registerEventProjector()` 显式接入。没有投影器的必需事件会形成粘性错误；带 `ignorable: true` 的事件可以忽略。

`registerRecordPreparer()` 在投影完成、Provider append 之前增加有序异步处理。preparer 可以先把完整大载荷耐久化到对象存储，再用对象引用替换载荷。它必须保留记录 ID、source sequence 和类型；违反约束或准备失败会成为该 Session 的粘性持久化错误。

读取持久化对话前调用 `ctx.sessions.flush(session)`。Session 或本插件销毁时也会启动最终排空。

## 映射与顺序

内置映射处理 `user/message`、`assistant/message`、`tool/call`、`tool/result` 和 `turn/end`，忽略 chunk、step 标记、请求快照、todo 快照和 seed 边界。消息正文只包含 `text` 块。工具结果保留完整的工具结果消息内容，空结果也会保留。

只有在某轮最新 step 已经开始、但没有完整 `assistant/message` 时，中止、打断或失败的轮次才生成 `assistant/interrupted`；部分文本永远不保存。每个轮次结束还会生成 `turn/completed`。进入 step 前取消，或完整助手消息之后取消，都不会虚构助手中断记录。

记录 ID 使用 `sessionId~sourceSequence`；一个源事件产生多条记录时增加语义后缀。消息记录沿用 Session 数据中已有的 LLM 消息 ID。轮次和 step ID 由 Session ID 与数字位置确定性生成。

一个 Session 事件可以在一次原子 append 中生成一组相邻且共享 `sourceSequence` 的记录。Provider 必须原子提交整组记录；即使该组单独超过配置的条数或字节上限，批处理也不会拆分它。绑定时插件扫描已有记录；只要该 `sourceSequence` 已存在，就删除整组待写记录。

同一 Session 的写入严格串行，不同 Session 可以并行。记录数、完整记录字节数或固定定时器都会关闭当前批次。容量、映射或 Provider 错误会粘在对应 Session 上，后续每次 flush 都返回第一次错误。

## 模型体验

### 语义持久化

#### 模型看到什么

什么也看不到。本插件不注册工具、提示词段、模型消息或 Session 事件。

#### Token 影响

为零。chunk 和语义记录都不会改变模型输入。

#### KV Cache 影响

没有影响。持久化不会重写模型可见前缀。

## 已知限制与后续工作

- 审批事件需要显式投影器：当前 Session 决定事件不能说明决定来自用户、管理员还是策略，审批请求也可能没有工具调用 ID。
- 子代理生命周期与文件发布目前没有可由本插件映射的持久 Session 事件。
- 默认仍内联保存工具结果，除非 record preparer 将其外置；文件元数据插件提供 256 KiB 对象存储策略。
- 本包不提供 MySQL 或本地文件 Conversation Provider。
