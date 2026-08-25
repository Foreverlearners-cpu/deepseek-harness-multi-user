# @deepseek-ai/dsh-conversation-mysql

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-conversation`](../conversation/README.md) 的 MySQL Provider。它注册 `ctx.conversations`，注入 Host-only `ctx.mysql` 连接服务，并永久保存语义 records 和查询投影。它不会修改或依赖 CDC 插件。

Provider 拥有 `dsh_conversation_schema`、`dsh_conversations`、`dsh_agent_records`、`dsh_conversation_messages`、`dsh_conversation_message_state` 和 `dsh_subagent_runs`。启动时使用数据库 scoped `GET_LOCK` 串行化 schema 初始化，拒绝不兼容或不完整的 schema，并且只在所有自有表都存在后记录版本 1。`occurred_at`、`created_at` 和 `updated_at` 使用 24 字符 canonical UTC 时间戳。面向 CDC 的 `dsh_conversation_messages` 表只包含 `tenant_id`、`user_id`、`session_id`、`message_id`、`revision`、`status`、`visibility`、`role`、`visible_text` 和 `occurred_at`；内部分页状态隔离在 `dsh_conversation_message_state`。消息文本使用 `MEDIUMTEXT`，`revision` 使用 `INT UNSIGNED`，消息身份使用四字段主键。

`append()` 锁定 scoped conversation 行，并在一个事务内提交 records、messages、subagent 投影、revision 和 `nextSequence`。共享 `sourceSequence` 的 records 保持在同一个相邻 group，并共享基于 canonical 完整 records 计算的 SHA-256。精确重试必须匹配每条 record 和 group hash。新 records 使用每批最多 64 行的多值 INSERT，因此 300 条 records 使用五条 record INSERT，但不会拆分外层事务。Provider 从不使用 `INSERT IGNORE`。

所有读取都要求 tenant、user 和 conversation 身份。列表查询使用与过滤条件绑定的不透明 keyset cursor，而不是 offset。V1 保留策略固定为永久；tenant 归档策略属于后续领域功能。

```yaml
- name: mysql
  config:
    host: 127.0.0.1
    user: dsh
    password: ${DSH_MYSQL_PASSWORD}
    database: dsh
- name: conversation-mysql
```

## 模型体验

### MySQL Conversation 持久化

#### 模型看到什么

`无`。Provider 只保存 Conversation Consumer 已选择的 records，不注册工具、prompt 或模型消息。

#### Token 影响

每次请求直接增加零个 Token。

#### KV Cache 影响

与模型请求无关。

## 已知限制与后续工作

- V1 只支持永久保留，归档和删除策略执行尚未实现。
- 版本 1 之后的 schema migration、replica 读取、CDC 发布和对象垃圾回收不属于本 Provider。
- 查询返回完整 records 和 messages；服务端全文搜索以及范围或对象 join 延后到投影层实现。
