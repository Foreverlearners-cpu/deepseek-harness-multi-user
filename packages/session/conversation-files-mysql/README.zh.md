# @deepseek-ai/dsh-conversation-files-mysql

[English](README.md) | 中文

不可变 Conversation 文件的 MySQL 元数据与 append 前外置插件。该插件注入 `ctx.mysql`、`ctx.fileStorage` 和 `ctx.conversationPersistence`，注册 `ctx.conversationFiles`，且不在 MySQL 中保存对象字节。

`publish()` 必须提供 tenant、user、conversation 和 file 身份。它先完成 `ctx.fileStorage.put()`，再开启 MySQL 事务，锁定并验证 owner-scoped conversation，然后写入对象引用与 conversation 关联。仅当同一 owner scope 下的 message 确实存在时，才接受可选的 message 关联。数据库失败会回滚元数据，但绝不会删除已就绪的不可变对象；不可达对象需要后续垃圾回收。

`get()`、`open()`、`list()` 和 `listMessageFiles()` 要求相同的 tenant、user 与 conversation scope。`open()` 通过 `ctx.fileStorage` 解析字节，绝不返回文件系统路径或 bearer URL。列表使用有界的 file-id keyset 分页。

该插件拥有 `dsh_conversation_files_schema`、`dsh_file_objects`、`dsh_conversation_files` 和 `dsh_conversation_message_files`。启动时使用 database-scoped advisory lock，并拒绝不兼容、不完整或没有版本记录的自有表。这些表独立于十列的 `dsh_conversation_messages` CDC 投影。

完整 `tool/result` record 会经过已注册的 record preparer。当 `JSON.stringify(payload.result)` 的 UTF-8 字节数严格大于 `toolResultObjectThresholdBytes` 时，JSON 会以 `application/json` 发布，`fileId` 从 `recordId` 确定性派生，`payload.result` 被移除，并记录 `payload.resultFileId`。等于阈值的值仍保留在 record 内。该插件不接收或保存 `assistant/chunk`。

```yaml
- name: mysql
  config:
    host: 127.0.0.1
    user: dsh
    password: ${DSH_MYSQL_PASSWORD}
    database: dsh
- name: file-storage-local
  config:
    root: /var/lib/dsh/objects
- name: conversation-mysql
- name: conversation-persistence
- name: conversation-files-mysql
  config:
    toolResultObjectThresholdBytes: 262144
```

## Model Experience

### Conversation 文件外置

#### What the model sees

模型在实时工具调用中收到相同结果。持久 Conversation 重放看到的是 `resultFileId`，而不是过大的内联 JSON；具备 owner 授权的 Consumer 可以解析完整对象。

#### Token effect

实时请求不会直接增加 token。后续重放 Consumer 决定是否以及将多少引用内容加入模型请求。

#### KV Cache effect

不影响实时请求。后续重放可以避免反复嵌入过大的工具 JSON。

## Known Limitations and Deferred Work

- V1 使用已配置的本地文件存储 Provider；不包含 MinIO 和 S3 Provider。
- 删除、保留策略执行、归档移动、对象引用计数和 orphan 垃圾回收均延后实现。
- 不可变对象发布与 MySQL 元数据无法共享一个原子事务；元数据失败可能留下安全但不可达的对象。
