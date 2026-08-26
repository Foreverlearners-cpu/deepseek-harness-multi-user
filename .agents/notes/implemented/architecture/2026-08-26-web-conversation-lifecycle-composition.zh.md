# Agent Note: Web Conversation 生命周期组合

Status: implemented

[English](2026-08-26-web-conversation-lifecycle-composition.md) | 中文

## Problem

Conversation 持久化要求在 Agent 发布前显式绑定，但 Web 创建、冷恢复、普通 fork 和内置进程内 subagent 路径分别拥有不同的 setup 回调。因此，只安装 Conversation Provider 只会创建数据表，并不会让这些运行时 Session 自动持久化。

## Decision

`@deepseek-ai/dsh-conversation-web` 是一个可选 Host 服务，对外提供一个 `AgentSetup` 组合器。ApiProxy 和两个进程内 subagent 生命周期所有者通过 `ctx.get('conversationWeb')` 使用它；服务不存在时，原有 setup 完全不变。已有的 preset、策略和子级 setup 先完成，绑定随后完成，并保留原始发布 commit。

新建 Web 会话和冷恢复使用 `dsh-conversation-starter` 的归属和标识。普通 Web fork 会成为一个独立的顶层 Conversation，使用相同的固定部署标签，同时在 Session 日志中保留 fork 祖先关系。它不会设置 `parentConversationId`，该字段继续只表示委派链路。subagent 保留 `origin: 'subagent'`，并从已绑定父级继承归属身份。

本插件只连接生命周期。部署仍需分别安装 MySQL、Conversation MySQL Provider、投影与写后 Consumer，以及本地归属 starter。发行默认配置保持与存储无关，MySQL 凭据继续由部署配置提供。

## Alternatives considered

**让 ApiProxy 直接依赖 Conversation 持久化。** 这会把存储策略强加给 Web gateway，并破坏有意不安装语义持久化的部署。

**把普通 fork 当成 subagent。** fork 祖先关系表示复制历史，不表示委派执行。复用 subagent 链路会破坏 Conversation 查询与归属语义。

**通过 `session/created` 绑定。** 该通知无法拒绝发布，也无法保证在第一条业务事件之前完成绑定。

**所有路径都使用可继续 subagent setup 注册表。** 该注册表负责同步且可撤销的子级能力，不覆盖顶层 Web Agent 或一次性子级；异步持久绑定具有不同的生命周期。

## Consequences

一个可选插件即可让 Web 创建、恢复、fork 和进程内 subagent 获得持久语义记录，同时不改变未配置的 Host。普通 fork 与委派链路保持不同语义。集成会给生命周期所有者增加少量可选类型边，而进程外子级运行时必须自行安装持久化组合。
