# `@deepseek-ai/dsh-conversation-web`

[English](README.md) | 中文

这是一个可选的生命周期适配插件。它会在 Agent 发布前，将 Web 会话、普通 Web fork 以及内置的进程内 subagent 会话绑定到语义 Conversation 持久化。未安装本插件时，ApiProxy 和 subagent 的行为保持不变。

## 组合方式

本适配器不会创建数据库连接，也不会选择 Conversation Provider。MySQL 部署需要在同一棵 Loader 树中安装完整链路：

```yaml
- name: mysql
  config:
    host: 127.0.0.1
    user: dsh
    password: ${DSH_MYSQL_PASSWORD}
    database: dsh
- name: conversation-mysql
- name: conversation-persistence
- name: conversation-starter
  config:
    tenantId: local-tenant
    localUserId: local-user
- name: conversation-web
```

`dsh-mysql` 提供 `ctx.mysql`；`dsh-conversation-mysql` 提供 `ctx.conversations`；`dsh-conversation-persistence` 对 Session 事件分类、投影完整语义事实并缓冲写入；`dsh-conversation-starter` 提供本地归属标签；本插件把这些服务接入 Agent 的创建和恢复入口。Web 适配器不注册事件专用投影器，因此 Web、headless 和其他组合共享同一套持久化行为。

Provider 会在启动时创建并校验自己的表。功能验证会查询 `dsh_conversation_schema` 中的 `schema_name = 'conversation'` 和 `version = 1`，发送一条唯一的 Web 消息，刷新 Session，然后在 `dsh_conversation_messages` 中找到该文本。流式 chunk 不会被保存。

## 生命周期语义

- 新建 Web 会话和冷恢复会绑定到同一个确定性 Conversation 标识。
- 普通 Web fork 是一个新的顶层 Conversation，并使用已配置的归属标签。它的 Session 头仍保留 `parentSession` 与 `seedLength`，但没有 Conversation 委派父级。
- 进程内一次性和可继续 subagent 以 `origin: subagent` 绑定，从已绑定父级继承 tenant 和 user，并保留 Conversation 委派链路。
- 已有的 preset、策略和子级 setup 会先执行，再执行绑定。失败会阻止 Agent 发布。

## 安全边界

starter 中固定的 tenant 和 user 值只是存储归属标签，不是认证。这个组合适用于本地或可信单用户部署。多用户 Web 部署必须用经过验证的认证和租户范围替换固定归属，之后才能依赖这些数据行做隔离。

## 模型体验

### Web Conversation 绑定

#### 模型看到什么

`无`。本适配器不注册工具、提示词、消息或 Session 事件。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

无。生命周期绑定不会改变模型请求前缀。

## 已知限制与后续工作

- 进程外 subagent Provider 拥有另一个进程，该进程必须自行安装 Conversation 链路。
- 绑定成功后，如果后续发布提交失败，可能留下一条空的幂等 Conversation 预留记录。
- 普通 Web fork 的祖先关系只保留在 Session 日志中；Conversation 委派链路专用于 subagent。
