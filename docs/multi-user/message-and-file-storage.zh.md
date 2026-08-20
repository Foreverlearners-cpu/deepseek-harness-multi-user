# ToC DSH 消息与文件存储说明

> 本文说明当前 `conversation-persistence-mysql` 插件的实际实现。流式 `assistant/chunk` 只存在于 Session 内存，不写入 MySQL；轮次结束后只保存最终业务消息。

## 1. 存储边界

当前数据分成三类：

```text
实时交互数据    Session 内存
最终业务消息    MySQL
文件原始字节    本地内容寻址对象存储
```

模型生成期间，chunk 进入内存并实时发送到 UI。轮次结束时，插件保存最终的 `user/message`、`assistant/message` 和 `tool/result`。模型中断时，保存一条 `status = partial` 的 assistant 消息，不需要持久化 chunk。

MySQL 是会话、消息、文件元数据和所有权关系的权威存储；文件字节不放进 MySQL 的 BLOB 字段。

## 2. 消息表：`dsh_conversation_messages`

表结构位于 `packages/session/conversation-persistence-mysql/src/schema.ts`。一行表示一条可恢复的业务消息。

| 字段 | 说明 |
| --- | --- |
| `message_id` | 消息唯一 ID，主键，也是重试写入时使用的幂等键。 |
| `session_id` | 所属会话 ID，关联 `dsh_conversations`。 |
| `user_id` | 所属用户 ID。查询必须带可信用户范围，不能只凭 session ID 访问。 |
| `ordinal` | 会话内消息顺序号，从 0 开始递增；`(session_id, ordinal)` 唯一。 |
| `event_type` | `user/message`、`assistant/message` 或 `tool/result`。 |
| `role` | `user`、`assistant` 或 `tool`，与 event_type 对应。 |
| `turn_no` | 第几轮用户交互。 |
| `step_no` | 当前轮中的第几步，工具链较长时一个 turn 可以有多个 step。 |
| `content_json` | 消息正文，使用 DSH 内容块格式保存。 |
| `source_json` | 消息来源和生成信息，例如 provider、model、user 或 tool。 |
| `tool_call_id` | 工具结果对应的调用 ID，普通消息通常为 NULL。 |
| `usage_json` | 输入/输出 token、缓存命中等模型用量信息。 |
| `visibility` | `user` 或 `internal`，表示是否属于用户可见内容。 |
| `status` | `completed`、`partial`、`failed`、`superseded`。 |
| `extensions` | 插件扩展 JSON，保存低频且非筛选属性。 |
| `created_at` | 创建时间，毫秒时间戳。 |
| `updated_at` | 更新时间，毫秒时间戳。 |

### 2.1 消息类型对应关系

```text
user/message      -> role = user
assistant/message  -> role = assistant
tool/result       -> role = tool
```

`event_type` 表示业务事件，`role` 表示对话角色。两者同时保存可以减少恢复时的推断。

### 2.2 `content_json` 示例

用户消息：

```json
[{ "type": "text", "text": "请分析这个项目" }]
```

带工具调用的 assistant 消息：

```json
[
  { "type": "text", "text": "我先检查项目状态。" },
  {
    "type": "tool-call",
    "id": "call-demo-status",
    "name": "bash",
    "arguments": "{\"command\":\"git status --short\"}"
  }
]
```

工具结果：

```json
[
  {
    "type": "tool-result",
    "toolCallId": "call-demo-status",
    "content": [{ "type": "text", "text": "{\"exitCode\":0}" }]
  }
]
```

### 2.3 turn 和 step 示例

```text
用户提问          turn_no=1, step_no=1
assistant 工具调用 turn_no=1, step_no=1
工具返回结果       turn_no=1, step_no=1
assistant 最终回答 turn_no=1, step_no=2
```

### 2.4 状态值

- `completed`：正常完成；
- `partial`：回答被中断，但已保存当前已组装内容；
- `failed`：消息或工具执行失败；
- `superseded`：被后续重试结果替代。

表上还定义了主键、会话内顺序唯一索引、用户/会话查询索引和工具调用索引。会话删除时，消息通过外键级联删除。

## 3. 消息写入流程

写入逻辑位于 `src/index.ts` 的 `appendMessagesAtomic()`：

```text
模型流式输出 chunk
        ↓
Session 内存缓冲并实时推送 UI
        ↓
轮次结束，组装最终消息
        ↓
事务写入 dsh_conversation_messages
        ↓
同一事务更新 conversation revision
        ↓
同一事务写入 model_attempts 和 Outbox
```

如果 MySQL 暂时不可用，可以把“最终消息写入命令”放入本地 durable spool 后重试；spool 也不保存每一个 chunk。

### 3.1 检查点与刷新时机

当前由独立的 `@deepseek-ai/dsh-session-checkpoint-policy` 决定何时调用持久化刷新，不由 MySQL 插件自行决定：

- 普通后台检查点默认在会话变脏 3 秒后触发；
- `user/message`、最终 `assistant/message`、`tool/result` 和标题变化会把会话标记为待刷新；
- `assistant/chunk` 只用于内存组装和实时 UI，不参与检查点计数，也不会写入消息 spool 或 MySQL 消息表；
- 下一次模型请求、顶层工具执行、步骤边界和会话关闭仍等待强制 flush；
- 刷新失败时保留内存中的待提交消息；强制边界失败会阻止后续模型或工具动作。

策略实现和扩展接口见 [`session-checkpoint-policy`](../../packages/session/session-checkpoint-policy/README.zh.md)。当前默认使用 `time` 策略，后续可注册 `event-count`、`hybrid` 或 `manual` 策略，而不改变消息表和文件存储接口。

## 4. 文件存储总体模型

```text
文件原始字节
    ↓
fileStorage 基础服务
    ↓
本地 / S3 / MinIO 对象存储
    ↓
dsh_file_objects              文件内容对象
    ↓
dsh_conversation_files        用户/会话文件元数据
    ↓
dsh_message_files             消息与文件的关联
    ↓
dsh_conversation_messages     具体消息
```

消息表没有直接的 `file_id` 列，也不保存文件二进制。文件引用通过 `dsh_message_files` 关联表完成。

## 5. 文件字节存储位置

当前 Web 配置为：

```yaml
- id: file-storage
  name: '@deepseek-ai/dsh-file-storage'
  config:
    root: dshHomePath('conversation-files/v1')
```

默认根目录：

```text
$DSH_HOME/conversation-files/v1
```

对象文件的路径格式：

```text
objects/<sha256 前两位>/<完整 sha256>
```

例如：

```text
$DSH_HOME/conversation-files/v1/objects/ab/abcdef1234567890...
```

`FileStorageService.put()` 会计算 SHA-256、生成对象路径、原子写入文件并返回摘要、提供方名称、路径和大小；读取时重新计算摘要，校验文件没有被篡改。内容相同的文件会复用同一个对象。

文件字节服务已经从 `conversation-persistence-mysql` 解耦。会话插件不再配置 `fileRoot`，也不再直接实例化本地对象存储，而是注入 `ctx.fileStorage`。因此以后替换为 S3 或 MinIO 时，只需替换文件存储服务，MySQL 的文件元数据和消息关联模型保持不变。

## 6. 三张文件表

### 6.1 `dsh_file_objects`

描述“实际文件内容对象”，一个对象可以被多个会话文件引用。

| 字段 | 说明 |
| --- | --- |
| `object_id` | 对象 ID，当前使用 SHA-256 十六进制字符串。 |
| `sha256` | 文件摘要，MySQL 类型为 `BINARY(32)`。 |
| `byte_size` | 文件字节数。 |
| `media_type` | MIME 类型，如 `image/png`、`application/pdf`。 |
| `storage_backend` | 当前为 `local`，以后可以扩展为 S3/MinIO。 |
| `storage_key` | 对象存储中的相对路径。 |
| `status` | `staging`、`ready`、`corrupt`、`deleting`。 |
| `created_at` / `verified_at` | 创建时间和校验时间。 |
| `extensions` | 对象级扩展字段。 |

### 6.2 `dsh_conversation_files`

描述“文件属于哪个用户和会话”。

| 字段 | 说明 |
| --- | --- |
| `file_id` | 业务层文件 ID。 |
| `user_id` | 文件所属用户。 |
| `session_id` | 文件所属会话。 |
| `object_id` | 指向 `dsh_file_objects.object_id`。 |
| `original_name` | 用户上传时的原始文件名。 |
| `media_type` / `byte_size` | 文件类型和大小。 |
| `purpose` | 文件用途，默认是 `message`。 |
| `status` | `ready`、`deleted`、`quarantined`。 |
| `extensions` | 文件业务扩展字段。 |
| `created_at` / `deleted_at` | 创建时间和软删除时间。 |

### 6.3 `dsh_message_files`

描述消息和文件之间的多对多关系。

| 字段 | 说明 |
| --- | --- |
| `session_id` | 会话 ID。 |
| `message_id` | 指向 `dsh_conversation_messages.message_id`。 |
| `file_id` | 指向 `dsh_conversation_files.file_id`。 |
| `ordinal` | 同一条消息中附件的排列顺序。 |
| `relation` | 文件与消息的关系，当前默认 `content`。 |
| `created_at` | 关联创建时间。 |

## 7. 上传、关联和读取

### 7.1 上传文件

调用 `saveFile(sessionId, input)`：

```text
1. 校验文件名、MIME 类型和大小
2. 将文件字节写入对象存储
3. 写入 dsh_file_objects
4. 写入 dsh_conversation_files
5. 返回 file_id
```

示例：

```ts
export {}
declare const persistence: any
declare const sessionId: string
declare const pdfBytes: Uint8Array
const file = await persistence.saveFile(sessionId, {
  originalName: 'design.pdf',
  mediaType: 'application/pdf',
  purpose: 'message',
  data: pdfBytes,
})
```

### 7.2 关联到消息

```ts
export {}
declare const persistence: any
declare const sessionId: string
declare const file: { fileId: string }
await persistence.appendMessage(sessionId, {
  eventType: 'user/message',
  role: 'user',
  content: [{ type: 'text', text: '请分析这个 PDF' }],
  fileIds: [file.fileId],
})
```

`fileIds` 是接口参数，不是消息表字段。插件在同一个 MySQL 事务中检查文件归属和状态，然后同时插入消息行和 `dsh_message_files` 关联行。

### 7.3 读取文件

```text
1. 按 user_id/session_id/file_id 查询文件元数据
2. 通过 object_id 查询 dsh_file_objects
3. 取得 storage_key
4. 调用 `ctx.fileStorage.get(storage_key, sha256)` 读取字节
5. 重新计算 SHA-256 并校验
6. 返回 metadata + data
```

所有读取都必须带当前认证用户的 `user_id`，不能仅凭前端传来的 session_id 或 file_id 授权。

## 8. 查询消息关联文件

插件提供 `listMessageFiles(sessionId, messageId)`。等价 SQL：

```sql
SELECT m.message_id, m.session_id,
       f.file_id, f.original_name, f.media_type, f.byte_size,
       f.object_id, o.storage_backend, o.storage_key
FROM dsh_conversation_messages AS m
JOIN dsh_message_files AS mf ON mf.message_id = m.message_id
JOIN dsh_conversation_files AS f ON f.file_id = mf.file_id
JOIN dsh_file_objects AS o ON o.object_id = f.object_id
WHERE m.message_id = ?
  AND m.session_id = ?
  AND m.user_id = ?
  AND f.status = 'ready'
ORDER BY mf.ordinal;
```

## 9. 当前演示数据

当前“文件上传与消息关联”会话包含文件相关的对话文字，但没有执行真实文件上传。因此当前数据库的三张文件表可能为空：

```text
dsh_conversation_files
dsh_file_objects
dsh_message_files
```

只有调用 `saveFile()` 并把返回的 `file_id` 传入消息写入流程后，文件表和本地对象目录才会出现实际记录。

## 10. 后续替换为 S3/MinIO

文件表使用 `storage_backend + storage_key` 抽象物理存储，因此后续可以将：

```text
local  ->  MinIO / S3
```

消息表、文件元数据表和消息关联表无需修改。MySQL 继续保存摘要、大小、所有权和引用关系，S3/MinIO 保存文件原始字节。
