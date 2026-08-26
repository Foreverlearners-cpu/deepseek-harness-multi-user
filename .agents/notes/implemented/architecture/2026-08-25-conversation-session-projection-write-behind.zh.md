# Agent Note：Conversation Session 投影写后缓冲

状态：已实现

[English](2026-08-25-conversation-session-projection-write-behind.md) | 中文

## 问题

[`@deepseek-ai/dsh-conversation`](../../../../packages/session/conversation/README.md) 保存完整语义记录，而运行时 Session 日志同时包含完整事实与高频流式 chunk。Consumer 必须恢复构造 seed 历史、排除临时事件、绑定租户所有权、保持源事件幂等，并防止繁忙 Agent Session 在进程中形成无界队列。

Session 事件通知发生在提交后，且不会等待观察者。持久化失败不能反向拒绝原始 `Session.append()`，但调用方仍然需要一个屏障判断所有已接纳语义记录是否到达 Conversation Provider。

## 决策

`@deepseek-ai/dsh-conversation-persistence` 监听 `session/created`、`session/event`、`session/flush` 和 `session/disposed`。恢复事件不会再次发出，因此它扫描构造 seed；它映射完整核心事件，并排除 `assistant/chunk` 与其他仅供运行时使用的状态。它不会追加 Session 事件。

应用在语义工作开始前显式调用 `attach(session, attachment)`。绑定通过 Conversation Provider 建立租户与用户所有权，分页扫描已有记录，并删除已存在的源事件组。记录、轮次和 step ID 根据 Session 位置确定性生成；Provider 分配连续业务序号。

一个 Session 源事件可以生成一组相邻且共享 `sourceSequence` 的语义记录，这组记录构成一次原子 Provider append。`turn/end` 发现未完成模型尝试时同时生成 `assistant/interrupted` 与 `turn/completed`；完整助手回答之后取消、进入 step 前取消或工具执行阶段取消，都不会虚构助手中断。部分助手文本永远不会写入。

工具副作用分类与插件自有必需事件投影都通过显式贡献注册。Consumer 自身负责完整分类共享 Session 事件：标题与审批审计对生成语义记录，已知 preset、inbox、策略、命令、压缩、Goal、Hook、重试、权限、调度、工作流和辅助请求状态只保留在 Session 中。未知副作用或未处理的必需事件会导致接纳失败，不会把操作静默视为安全，也不会丢弃持久语义。可忽略扩展事件可以跳过。

消息记录显式携带可见性。人类输入为 `user`；插件或运行时上下文注入的输入为 `internal`；完整助手消息为 `user`。审批决定会保留已知的确定性 `never` 策略来源；源事件没有决定者身份时使用 `unknown`，不会虚构用户或管理员。

每个 Session 拥有有界队列和串行 Promise 链。第一条待写记录启动固定定时器；目标完整记录的条数或精确 UTF-8 字节数可以提前关闭批次。source group 不可拆分，单组超过上限时独立写入。有序异步 record preparer 可以在 append 前耐久化完整载荷，但不能改变记录的源身份或顺序。不同 Session 控制器可以并发调用 Provider。容量、准备、投影和 Provider 错误保留第一次失败、停止自动写入，并使之后每次 flush 都失败。Flush 取消等待并立即排空；Session 与插件销毁会启动最终排空，插件生命周期允许时会等待所有工作静止。

默认值为 500 毫秒、64 条记录、524288 字节，以及每个 Session 4096 条待写记录。

## 考虑过的替代方案

**持久化每个流式 chunk。** Session 持久化已经负责无损回放。chunk 行不会改善语义恢复，只会放大业务存储写入。

**使用一个进程级队列。** 一个受阻 Session 会串行阻塞无关租户与 Agent。每 Session 控制器在保持局部顺序的同时允许独立推进。

**根据名称推断工具副作用，或默认为只读。** 名称不能证明副作用行为。显式策略会在语义持久化继续前，把未知分类暴露为配置错误。

**无限自动重试 Provider 失败。** Provider 不可用且 Agent 持续工作时可能耗尽内存。粘性失败让队列停在已知上限，并把恢复策略交给持久化屏障的调用方。

## 结果

Conversation Provider 以更少、更大的原子 append 接收数据，同时保留记录级恢复。崩溃可能丢失当前缓冲批次，但恢复会从上一组完整语义源记录继续，而不是从 chunk 边界继续。

应用组合必须在语义事件前提供绑定与工具副作用策略。subagent 和文件集成保持显式，因为当前 Session 事实不包含对应语义记录所需的全部字段。本地对象存储与文件元数据插件通过 record-preparer 接口应用独立的 256 KiB 结果外置策略。共享事件分类属于此 Consumer，而不是 Web 生命周期适配器，因此所有组合都获得相同的严格行为。
