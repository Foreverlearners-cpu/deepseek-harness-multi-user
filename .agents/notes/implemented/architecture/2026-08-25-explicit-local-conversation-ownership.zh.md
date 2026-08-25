# Agent Note: 显式本地对话归属

Status: implemented

[English](2026-08-25-explicit-local-conversation-ownership.md) | 中文

## Problem

语义对话持久化要求在第一条业务记录之前确定 tenant、user、conversation 和 Session 身份。本地与 headless 部署没有可用于派生 owner 的已认证调用或租户作用域，而异步 `session/created` 监听器无法在发布前完成绑定，也无法拒绝创建。

## Decision

`@deepseek-ai/dsh-conversation-starter` 提供固定的 `local-tenant` 与 `local-user` 默认值，并公开显式 `AgentSetup` 适配器。这些值是存储归属标签，不是认证、授权或不可信租户隔离。本 starter 不读取请求头，也不挂载 MySQL、文件存储或身份服务。

创建与恢复入口调用 `ctx.conversationStarter.compose(existingSetup)`。已有 setup 先完成，使其未发布 Session 事件可被绑定时的 seed 扫描读取，同时 setup 失败不会产生预留。随后绑定在 Agent 发布前完成，并原样返回已有的同步发布 commit。starter 不安装 `session/created` 监听器。

每个运行时 Session id 都通过 `session-` 加完整 UTF-8 值的 SHA-256 摘要映射为 Conversation id。绑定使用的 Session id 必须保留运行时原值，因为 conversation persistence 会验证二者相同。因此运行时 Session id 必须满足 Conversation 标识符语法和长度；非法值会在未发布 setup 中失败。摘要在恢复时生成相同对话绑定。

根 Session 没有父 lineage，并使用配置的固定 owner、顶层来源、零深度和永久保留策略。子 Session 必须同时具有 `origin: 'subagent'`、`parentSession` 和正数 delegation depth。它的绑定只指定父 Session，因此 Conversation Provider 会继承父 owner。残缺 lineage、缺失的父绑定，以及没有 subagent 来源的普通 fork 都会在发布前失败。

内置 one-shot 和 continuable subagent 实现拥有自己的 setup 回调，并且没有异步全局贡献点。因此 starter 只覆盖显式组合它的创建路径，不宣称透明覆盖内置 subagent 工具。

## Alternatives considered

**使用异步 `session/created` 绑定。** Cordis 生命周期通知不会把监听器 Promise 当作创建前置条件等待，因此业务事件可能早于绑定，拒绝也只会被记录。

**把原始 Session id 直接作为 Conversation id。** Core Session id 是任意 branded string，而 Conversation id 有受限语法和长度。对 conversation identity 计算摘要可避免额外语法冲突，而 attachment identity 为满足 persistence 相等检查仍保留原值。

**把固定 owner 当作本地认证 Provider。** 存储标签提供稳定查询 key，但不建立调用者身份或访问决定。把它们描述为安全能力会让不安全的多用户部署看起来受到保护。

**修改每个 subagent Provider。** Starter 保持为普通显式适配器，不把本包职责扩展到 core 或 subagent 生命周期。如果需要透明覆盖，可以另行设计异步 setup 扩展能力。

## Consequences

根 Session 与显式组合的子 Session 在发布前获得稳定永久归属，畸形 lineage 会尽早失败，恢复能定位同一对话。调用方必须组合每个创建路径，并生成符合 Provider 规则的 Session id。如果绑定成功后发布 commit 失败，Conversation 服务因没有接纳回滚操作而可能保留空的幂等预留。多用户部署需要独立的已认证组合，以及由 Provider 强制执行的租户访问检查。
