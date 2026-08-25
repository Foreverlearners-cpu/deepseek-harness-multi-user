# Agent Note: Owner-scoped Conversation 文件对象元数据

Status: implemented

[English](2026-08-25-conversation-file-object-metadata.md) | 中文

## 问题

完整工具结果和模型生成文件可能超过语义 MySQL record 的实用大小。把字节存入关系行会让对象传输时间进入事务，而只保存原始本地路径会绕过 tenant 与 user 所有权。对象发布与关系元数据也无法共享一个原子提交，因此失败顺序不得销毁可能已被其他并发发布者引用的对象。

## 决策

`@deepseek-ai/dsh-conversation-files-mysql` 将不可变 `ctx.fileStorage` Provider 与 MySQL owner 元数据组合起来。它先发布完整字节，再锁定准确的 `(tenantId, userId, conversationId)` 行，并在一个事务中提交 `dsh_file_objects`、`dsh_conversation_files` 以及可选的 `dsh_conversation_message_files` 关联。每个公开读写 API 都包含 tenant、user 与 conversation 身份。关联 message 时还会验证该 owner-scoped conversation 内的 message。

元数据 schema 拥有独立版本行和 database-scoped advisory lock。它不修改 Conversation Provider 的 records、messages 或面向 CDC 的十列 message 表。保存的对象引用保留 Provider 签发的 backend、opaque key、摘要与字节长度；Consumer 绝不持久化或返回文件系统路径或 bearer URL。

该插件注册一个异步 Conversation record preparer。完整 `tool/result` JSON 的 UTF-8 字节数严格大于默认可配置的 256 KiB 时，会以 `application/json` 发布；`recordId` 的 SHA-256 派生稳定 `fileId`，prepared record 使用 `resultFileId` 替换 `result`。preparer 绝不会收到 `assistant/chunk`，本插件也不定义 chunk 表或 API。

如果对象发布成功而 MySQL 失败，对象会保持不可变并且可能不可达。该操作绝不尝试补偿删除，因为 content-addressed 发布可能被并发 owner 或重试去重。后续 owner-aware 引用计数与垃圾回收可以回收已证明不可达的对象。

## 备选方案

**先写 MySQL 元数据，再发布对象。** 已提交的行可能引用最终未就绪的字节，破坏完整读取语义。

**元数据回滚时删除对象。** 同一个不可变对象可能已被精确重试或并发发布引用，补偿删除会损坏有效数据。

**把大型 JSON 直接存入 MySQL。** 这会扩大语义 record 事务，并在重放时重复大型 payload，而不是保留一个不可变对象引用。

**保存本地文件系统路径。** 路径会暴露 Provider 内部实现，无法表示后续存储 Provider，也不强制 tenant 与 user 所有权。

## 结果

Conversation records 保持有界，owner-scoped API 无需修改 CDC 表即可解析完整对象。精确 preparer 重试会派生相同文件身份，本地 content-addressed 存储会对字节去重。刻意采用的对象优先顺序可能在元数据失败后占用存储，因此 V1 优先保障数据安全，而不是立即回收。V1 只交付本地 Provider，并延后删除、归档移动、MinIO、S3 和 orphan 回收。
