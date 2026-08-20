# Agent Note：MySQL 会话采用直接用户归属

Status: implemented

[English](2026-08-20-mysql-conversations-direct-user-ownership.md) | 中文

## 问题

ToC 会话存储服务于个人用户，不实现团队、组织、租户或其他所有者类别。多态的 `owner_kind/owner_id` 组合让关系型 schema、插件 API、授权谓词和运维查询描述了产品无法创建的所有者类型。

## 决策

`@deepseek-ai/dsh-conversation-persistence-mysql` 从 Host 组合接收一个可信 `userId`，并在 `dsh_conversations`、`dsh_conversation_files` 和 `dsh_conversation_outbox` 中保存为 `user_id`。每个字段都外键关联 `dsh_users.user_id`；schema v2 会拒绝旧的 owner 字段布局，直到显式数据库迁移完成字段改名并删除 `owner_kind`。子行是否直接保存用户字段的决定记录在[直接用户归属子表说明](2026-08-20-mysql-child-rows-direct-user-ownership.md)中。

Message-file 关联继续通过 message 和 file 外键确定关系。Conversation message 和模型 attempt 按链接说明直接保存 `user_id`，并接受联合一致性约束。

持久化 message spool 同样记录 `userId`，SessionPersistence 适配器从 conversation 行恢复 `SessionHeader.userId`。请求 payload 不能选择用户范围。

## 考虑过的替代方案

**为可能的团队所有权保留 `owner_kind/owner_id`。** 不采用，因为当前没有服务、外键、授权规则或 UI 能表示非用户所有者。未来的组织能力需要显式 schema 和成员关系模型，而不是未使用的判别字段。

**把 `user_id` 复制到每张关联表。** `dsh_message_files` 暂不复制，因为它的 message 和 file 外键已经确定当前关系；高频 message 和 attempt 采用单独的直接归属决策。

**只改 TypeScript 字段而保留 owner 命名的 SQL 列。** 不采用，因为数据库检查和运维 SQL 也是可维护接口的一部分；物理 schema 必须与插件 API 表达同一个用户模型。

## 结果

Conversation 和文件查询使用一个明确的用户谓词，数据库运维人员无需解释判别字段即可识别用户归属。schema 不再支持多态所有权；新增团队或组织需要明确的新能力和 schema 迁移。直接保存用户字段的 message 和 attempt 仍必须同时使用认证 `user_id` 与 `session_id`，不能把裸 `session_id` 当作权限凭据。
