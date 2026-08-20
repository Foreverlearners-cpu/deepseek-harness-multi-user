import { randomUUID } from 'node:crypto'
import { createConnection } from '../packages/session/conversation-persistence-mysql/node_modules/mysql2/promise.js'

const target = process.env.DSH_MYSQL_URL ?? 'mysql://root:123456@127.0.0.1:13306/dsh_test'
const url = new URL(target)
const userId = process.env.DSH_USER_ID ?? 'demo-user'
const connection = await createConnection({
  host: url.hostname,
  port: url.port === '' ? 3306 : Number(url.port),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)),
})

interface SeedMessage {
  id: string
  eventType: 'user/message' | 'assistant/message' | 'tool/result'
  role: 'user' | 'assistant' | 'tool'
  turn: number
  step: number
  content: unknown
  source: unknown
  toolCallId?: string
  usage?: unknown
  visibility?: 'user' | 'internal'
  status?: 'completed' | 'partial' | 'failed' | 'superseded'
}

interface SeedConversation {
  id: string
  title: string
  titleStatus: 'generated' | 'manual' | 'fallback'
  status: 'active' | 'archived'
  updatedAt: number
  messages: SeedMessage[]
}

const text = (value: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: value }]
const assistant = (id: string, turn: number, step: number, content: unknown, source: unknown, extra: Partial<SeedMessage> = {}): SeedMessage => ({
  id, eventType: 'assistant/message', role: 'assistant', turn, step, content, source, ...extra,
})
const user = (id: string, content: string, turn = 1, step = 1): SeedMessage => ({
  id, eventType: 'user/message', role: 'user', turn, step, content: text(content), source: { kind: 'user' },
})
const tool = (id: string, callId: string, content: unknown, turn: number, step: number, status: SeedMessage['status'] = 'completed'): SeedMessage => ({
  id, eventType: 'tool/result', role: 'tool', turn, step, content: [{ type: 'tool-result', toolCallId: callId, content: text(JSON.stringify(content)) }],
  source: { kind: 'tool', callId }, toolCallId: callId, visibility: 'internal', status,
})

const now = Date.now()
const modelSource = { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }
const seeded: SeedConversation[] = [
  {
    id: 'demo-seed-architecture', title: 'ToC DSH 架构设计', titleStatus: 'generated', status: 'active', updatedAt: now - 5 * 60_000,
    messages: [
      user('demo-seed-architecture-u1', '请总结一下 ToC DSH 的整体架构。'),
      assistant('demo-seed-architecture-a1', 1, 1, text('ToC DSH 可以分为 Web/API、Agent Runtime、MySQL 持久化和文件对象存储四层。'), modelSource, { usage: { inputTokens: 128, outputTokens: 42 } }),
      user('demo-seed-architecture-u2', 'MySQL 在其中承担什么职责？', 2, 1),
      assistant('demo-seed-architecture-a2', 2, 1, text('MySQL 保存会话元数据、最终 message、工具结果、attempt、文件元数据和 Outbox；chunk 只在内存中流式传输。'), modelSource, { turn: 2, usage: { inputTokens: 210, outputTokens: 55 } }),
    ],
  },
  {
    id: 'demo-seed-files', title: '文件上传与消息关联', titleStatus: 'manual', status: 'active', updatedAt: now - 45 * 60_000,
    messages: [
      user('demo-seed-files-u1', '上传一个 PDF 后，文件和消息分别存在哪里？'),
      assistant('demo-seed-files-a1', 1, 1, text('文件字节进入内容寻址对象存储，MySQL 只保存文件元数据和 user_id/session_id 归属。消息通过 dsh_message_files 建立引用。'), modelSource, { usage: { inputTokens: 150, outputTokens: 48 } }),
      user('demo-seed-files-u2', '那页面刷新后还能下载吗？', 2, 1),
      assistant('demo-seed-files-a2', 2, 1, text('可以。页面重新读取文件元数据，通过当前用户和会话授权后再读取对象字节。'), modelSource, { usage: { inputTokens: 188, outputTokens: 35 } }),
    ],
  },
  {
    id: 'demo-seed-tools', title: '多步骤工具调用示例', titleStatus: 'generated', status: 'active', updatedAt: now - 2 * 60 * 60_000,
    messages: [
      user('demo-seed-tools-u1', '请读取项目状态并给出建议。'),
      assistant('demo-seed-tools-a1', 1, 1, [
        { type: 'text', text: '我先检查项目状态。' },
        { type: 'tool-call', id: 'call-demo-status', name: 'bash', arguments: '{"command":"git status --short"}' },
      ], modelSource, { usage: { inputTokens: 220, outputTokens: 64 } }),
      tool('demo-seed-tools-t1', 'call-demo-status', { exitCode: 0, output: '工作区有 3 个待提交文件' }, 1, 1),
      assistant('demo-seed-tools-a2', 1, 2, text('当前工作区有 3 个待提交文件。建议先确认这些修改属于本次功能，再运行测试后提交。'), modelSource, { turn: 1, step: 2, usage: { inputTokens: 310, outputTokens: 44 } }),
    ],
  },
  {
    id: 'demo-seed-interrupted', title: '中断的模型回答', titleStatus: 'fallback', status: 'active', updatedAt: now - 5 * 60 * 60_000,
    messages: [
      user('demo-seed-interrupted-u1', '解释一下异步持久化失败时如何恢复。'),
      assistant('demo-seed-interrupted-a1', 1, 1, text('当 MySQL 暂时不可用时，已组装的最终 message 会进入本地 durable spool，恢复后继续重试写入。'), modelSource, {
        usage: { inputTokens: 122, outputTokens: 31 }, status: 'partial',
      }),
    ],
  },
  {
    id: 'demo-seed-archived', title: '已归档的旧会话', titleStatus: 'fallback', status: 'archived', updatedAt: now - 2 * 24 * 60 * 60_000,
    messages: [
      user('demo-seed-archived-u1', '这是一条已归档会话，用来验证列表状态。'),
      assistant('demo-seed-archived-a1', 1, 1, text('归档后仍可查看历史，但默认不会出现在活动会话列表中。'), modelSource, { usage: { inputTokens: 96, outputTokens: 27 } }),
    ],
  },
]

await connection.beginTransaction()
try {
  await connection.query('DELETE FROM dsh_conversation_outbox WHERE user_id = ? AND session_id LIKE \'demo-seed-%\'', [userId])
  await connection.query('DELETE FROM dsh_conversations WHERE user_id = ? AND session_id LIKE \'demo-seed-%\'', [userId])
  for (const conversation of seeded) {
    const createdAt = conversation.updatedAt - 60_000
    await connection.query(
      `INSERT INTO dsh_conversations
       (session_id, version, user_id, title, title_status, title_source, title_revision, title_updated_at,
        status, cwd, parent_session_id, seed_length, origin, delegation_depth, agent_preset, incarnation,
        revision, next_message_ordinal, extensions, created_at, updated_at)
       VALUES (?, 0, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, '{}', ?, ?)`,
      [conversation.id, userId, conversation.title, conversation.titleStatus,
        conversation.titleStatus === 'manual' ? 'user' : 'seed', conversation.updatedAt,
        conversation.status, 'C:\\DSH\\deepseek-harness', conversation.status === 'active' ? 'standard' : null,
        randomUUID(), conversation.messages.length, conversation.messages.length, createdAt, conversation.updatedAt],
    )
    let revision = 0
    for (const message of conversation.messages) {
      const ordinal = revision
      revision += 1
      const created = createdAt + revision * 10_000
      await connection.query(
        `INSERT INTO dsh_conversation_messages
         (message_id, session_id, user_id, ordinal, event_type, role, turn_no, step_no,
          content_json, source_json, tool_call_id, usage_json, visibility, status, extensions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
        [message.id, conversation.id, userId, ordinal, message.eventType, message.role, message.turn, message.step,
          JSON.stringify(message.content), JSON.stringify(message.source), message.toolCallId ?? null,
          message.usage === undefined ? null : JSON.stringify(message.usage), message.visibility ?? 'user', message.status ?? 'completed', created, created],
      )
      if (message.eventType === 'assistant/message') {
        await connection.query(
          `INSERT INTO dsh_model_attempts
           (attempt_id, session_id, user_id, turn_no, step_no, retry_no, provider, model, status,
            started_at, first_token_at, finished_at, finish_reason, usage_json, final_message_id,
            partial_content_json, error_code, error_message, extensions)
           VALUES (?, ?, ?, ?, ?, 0, 'deepseek', 'deepseek-chat', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '{}')`,
          [`attempt-${message.id}`, conversation.id, userId, message.turn, message.step,
            message.status === 'partial' ? 'cancelled' : 'completed', created - 500, created, created,
            message.status === 'partial' ? 'interrupted' : 'stop', message.usage === undefined ? null : JSON.stringify(message.usage),
            message.id, message.status === 'partial' ? JSON.stringify(message.content) : null],
        )
      }
      await connection.query(
        `INSERT INTO dsh_conversation_outbox
         (outbox_id, schema_version, event_type, aggregate_type, aggregate_id, user_id, session_id, message_id,
          aggregate_revision, payload_json, extensions, occurred_at)
         VALUES (?, 1, 'conversation.message.committed', 'conversation', ?, ?, ?, ?, ?, ?, '{}', ?)`,
        [randomUUID(), conversation.id, userId, conversation.id, message.id, revision,
          JSON.stringify({ role: message.role, status: message.status ?? 'completed' }), created],
      )
    }
  }
  await connection.commit()
  console.log(`Seeded ${seeded.length} conversations for ${userId}`)
} catch (error) {
  await connection.rollback()
  throw error
} finally {
  await connection.end()
}
