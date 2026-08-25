# @deepseek-ai/dsh-conversation-files-mysql

English | [中文](README.zh.md)

MySQL metadata and append-time externalization for immutable conversation files. The plugin injects `ctx.mysql`, `ctx.fileStorage`, and `ctx.conversationPersistence`, registers `ctx.conversationFiles`, and stores no object bytes in MySQL.

`publish()` requires tenant, user, conversation, and file identity. It completes `ctx.fileStorage.put()` before opening a MySQL transaction, locks and verifies the owner-scoped conversation, then writes the object reference and conversation association. An optional message association is accepted only when that exact owner-scoped message exists. A database failure rolls back metadata but never deletes the ready immutable object; unreachable objects require later garbage collection.

`get()`, `open()`, `list()`, and `listMessageFiles()` require the same tenant, user, and conversation scope. `open()` resolves bytes through `ctx.fileStorage` and never returns a filesystem path or bearer URL. Lists use bounded file-id keyset pagination.

The plugin owns `dsh_conversation_files_schema`, `dsh_file_objects`, `dsh_conversation_files`, and `dsh_conversation_message_files`. Startup uses a database-scoped advisory lock and rejects incompatible, incomplete, or unversioned owned tables. These tables are independent of the ten-column `dsh_conversation_messages` CDC projection.

Complete `tool/result` records pass through a registered record preparer. When `JSON.stringify(payload.result)` is strictly greater than `toolResultObjectThresholdBytes` in UTF-8, the JSON is published as `application/json`, `fileId` is derived deterministically from `recordId`, `payload.result` is removed, and `payload.resultFileId` is recorded. Values equal to the threshold remain inline. `assistant/chunk` is not accepted or stored by this plugin.

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

### Conversation file externalization

#### What the model sees

The model receives the same live tool result. Durable conversation replay sees a `resultFileId` instead of oversized inline JSON and can resolve the complete object through an owner-authorized consumer.

#### Token effect

Zero direct tokens during the live request. A later replay consumer decides whether and how much referenced content enters a model request.

#### KV Cache effect

No effect on the live request. Later replay can avoid repeatedly embedding oversized tool JSON.

## Known Limitations and Deferred Work

- V1 uses the configured local file storage Provider; MinIO and S3 Providers are not included.
- Deletion, retention execution, archive movement, object reference counting, and orphan garbage collection are deferred.
- Immutable object publication and MySQL metadata cannot share one atomic transaction; a metadata failure can leave a safe unreachable object.
