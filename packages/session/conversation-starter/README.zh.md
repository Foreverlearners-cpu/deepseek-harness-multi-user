# `@deepseek-ai/dsh-conversation-starter`

[English](README.md) | 中文

为语义对话持久化提供显式的本地/headless 数据归属绑定。它提供一个 `AgentSetup` 适配器，在 Agent 发布前绑定每个 Session。

**`local-tenant` 和 `local-user` 仅为存储归属标签。** 本包不认证调用者、不授权读写、不隔离不可信租户，也不把请求头当作身份。多用户部署必须从已验证的认证结果和租户作用域派生归属，并在 Conversation Provider 中强制执行。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `tenantId` | `local-tenant` | 根对话的固定归属标签 |
| `localUserId` | `local-user` | 根对话的固定归属标签 |

本插件注入 `conversationPersistence`；部署需要分别挂载 `dsh-session`、一个 `dsh-conversation` Provider 和 `dsh-conversation-persistence`。本包不会挂载 MySQL 或文件存储。

## Agent Setup

每个 Agent 创建和恢复入口都必须显式组合 starter：

```ts
const handle = await ctx.agents.create({
  sessionId,
  setup: ctx.conversationStarter.compose(existingSetup),
})
```

已有 setup 先完成，starter 随后等待对话绑定，并原样返回已有的发布 commit。setup 或绑定失败都会阻止 Session 和 Agent 发布。starter 绝不使用异步 `session/created` 监听器。

根 Session 使用配置的归属标签、永久保留策略、顶层来源和零深度。子 Session 必须同时具有 `origin: 'subagent'`、`parentSession` 和正数 `delegationDepth`；Conversation Provider 通过父绑定继承 tenant 与 user。缺失或冲突的 lineage 会在发布前失败。普通 `SessionStore.fork()` 只有 `parentSession` 而没有 subagent 来源，因此不受支持。

`stableSessionIdentity()` 对完整运行时 Session id 计算 SHA-256，生成固定长度的 Conversation id。绑定使用的 Session id 必须保留运行时原值，因为 `dsh-conversation-persistence` 会验证二者完全相同。因此，不满足 Conversation id 语法的 Session id 会在发布前失败；新建和恢复仍会定位到同一对话。

## 模型体验

无。本 Host 适配器不注册工具、提示词、消息或 Session 事件。

## 已知限制与延后工作

- 内置 one-shot 和 continuable subagent 路径拥有自己的 setup 回调，且没有异步全局 setup 扩展点。本包不会自动覆盖这些路径；创建入口必须显式组合本 starter。
- 即使 core `SessionId` 接受任意字符串，运行时 Session id 仍必须符合 Conversation 服务的标识符语法和长度。
- 绑定成功后，如果已有 setup 的发布 commit 随后失败，Provider 可能保留一条空的幂等对话预留，因为 Conversation 服务没有接纳回滚操作。
- 已认证的多用户归属和租户访问控制需要另外基于已验证身份与租户作用域进行装配。
