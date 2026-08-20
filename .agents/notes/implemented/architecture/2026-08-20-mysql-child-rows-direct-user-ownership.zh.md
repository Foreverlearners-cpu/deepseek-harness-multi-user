# Agent Note：MySQL 子表直接保存用户归属

Status: implemented

[English](2026-08-20-mysql-child-rows-direct-user-ownership.md) | 中文

## 问题

ToC 服务需要按认证用户读取和路由大量 message、attempt 行。如果每个调用方都必须连表查询 conversation，新增查询很容易漏写授权谓词，也不利于直接按用户导出、清理、分区和路由。

## 决策

`dsh_conversation_messages` 和 `dsh_model_attempts` 直接保存 `user_id`。原本已经带有用户字段的文件和 Outbox 行也增加 `(session_id, user_id)` 联合外键，与 `dsh_conversations` 保持一致。消息和 attempt 查询同时使用 `user_id` 与 `session_id`。

该冗余由系统控制，不接受调用方自行填写：持久化插件始终从可信配置取得 `user_id`，MySQL 拒绝用户字段与所属会话不一致的子行。增量迁移期间保留旧的 Session 外键，旧安装仍保有原有引用约束。

## 考虑过的替代方案

**只在 conversation 保存用户归属。** 不采用，因为本产品的高频子表查询和下游路由都需要连表，漏写 Join 谓词可能导致跨用户读取。

**只复制字段而不加数据库约束。** 不采用，因为过期或伪造的 `user_id` 会把冗余变成安全缺陷。联合外键保留 conversation 的权威关系，同时提供直接查询路径。

**给每一张关联表都增加 `user_id`。** `dsh_message_files` 暂缓；它的 message、file 外键已经确定关联关系，当前访问路径没有因再次复制用户字段而得到明显收益。

## 结果

消息和 attempt 可以直接按用户过滤、导出、路由和建立索引，不需要连 conversation。Schema 增加了索引和从会话回填子行的迁移步骤。后续写入路径仍必须使用认证插件用户，并保持联合外键约束。
