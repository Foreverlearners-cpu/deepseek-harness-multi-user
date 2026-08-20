/** Project the legacy full event-log MySQL tables into message-only tables. */

import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { createPool } from '../packages/multi/mysql/node_modules/mysql2/promise.js'
import type { RowDataPacket } from '../packages/multi/mysql/node_modules/mysql2/index.js'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'
import { ensureSchema, SCHEMA_VERSION, CONVERSATIONS_TABLE, MESSAGES_TABLE, OUTBOX_TABLE } from '../packages/session/conversation-persistence-mysql/src/schema.ts'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'

const url = process.env.DSH_MYSQL_URL ?? process.env.DSH_MYSQL_TEST_URL
if (url === undefined) throw new Error('set DSH_MYSQL_URL=mysql://user:password@host:port/database')
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const requestedUser = process.env.DSH_USER_ID
const requestedSession = process.env.DSH_SESSION_ID

function decodeRows(rows: readonly { payload: Buffer | string; codec: string; checksum: Buffer | string; seq_from: number; event_count: number }[]): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const row of rows) {
    const plain = row.codec === 'gzip-json'
      ? gunzipSync(Buffer.isBuffer(row.payload) ? row.payload : Buffer.from(row.payload))
      : Buffer.isBuffer(row.payload) ? row.payload : Buffer.from(row.payload)
    const digest = createHash('sha256').update(plain).digest()
    const expected = Buffer.isBuffer(row.checksum) ? row.checksum : Buffer.from(row.checksum)
    if (!digest.equals(expected)) throw new Error(`legacy record checksum mismatch at seq ${row.seq_from}`)
    const record = JSON.parse(plain.toString('utf8')) as unknown
    const decoded = decodeStorageRecord(record)
    if (decoded.length !== row.event_count) throw new Error(`legacy record event count mismatch at seq ${row.seq_from}`)
    events.push(...decoded)
  }
  return events
}

type MigratedMessage = {
  messageId: string; eventType: 'user/message' | 'assistant/message' | 'tool/result'; role: 'user' | 'assistant' | 'tool'
  turnNo: number; stepNo: number; content: unknown; source: unknown; toolCallId: string | null; usage: unknown; visibility: 'user' | 'internal'; status: 'completed' | 'partial' | 'failed'; extensions: Record<string, unknown>; createdAt: number
}

function messageRows(events: readonly SessionEvent[]): MigratedMessage[] {
  const rows: MigratedMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const turnEvent = events.findLast(item => item.type === 'turn/start' && item.seq <= event.seq) as Extract<SessionEvent, { type: 'turn/start' }> | undefined
      const stepEvent = events.findLast(item => item.type === 'step/start' && item.seq <= event.seq) as Extract<SessionEvent, { type: 'step/start' }> | undefined
      rows.push({
        messageId: String(event.data.id), eventType: 'user/message' as const, role: 'user' as const,
        turnNo: turnEvent?.data.turn ?? 0, stepNo: stepEvent?.data.step ?? 0,
        content: event.data.content, source: event.data.source, toolCallId: null, usage: null,
        visibility: event.data.source.kind === 'user' ? 'user' as const : 'internal' as const,
        status: 'completed' as const, extensions: {}, createdAt: event.time,
      })
      continue
    }
    if (event.type === 'assistant/message') {
      rows.push({
        messageId: String(event.data.message.id), eventType: 'assistant/message' as const, role: 'assistant' as const,
        turnNo: event.data.turn, stepNo: event.data.step, content: event.data.message.content,
        source: event.data.message.source, toolCallId: null, usage: event.data.usage ?? null,
        visibility: 'user' as const, status: 'completed' as const, extensions: {}, createdAt: event.time,
      })
      continue
    }
    if (event.type === 'tool/result') {
      rows.push({
        messageId: String(event.data.message.id), eventType: 'tool/result' as const, role: 'tool' as const,
        turnNo: event.data.turn, stepNo: event.data.step, content: event.data.message.content,
        source: event.data.message.source, toolCallId: String(event.data.message.source.callId), usage: null,
        visibility: 'internal' as const, status: event.data.error === undefined ? 'completed' as const : 'failed' as const,
        extensions: event.data.meta === undefined ? {} : { 'tool:meta': event.data.meta }, createdAt: event.time,
      })
    }
  }
  return rows
}

async function main(): Promise<void> {
  const target = new URL(url!)
  const pool = createPool({
    host: target.hostname, port: target.port === '' ? 3306 : Number(target.port),
    user: decodeURIComponent(target.username), password: decodeURIComponent(target.password),
    database: decodeURIComponent(target.pathname.slice(1)), connectionLimit: 2,
  })
  try {
    await pool.query('SELECT 1')
    await ensureSchema(pool as never)
    const [sessions] = await pool.query<Array<{
      session_id: string; version: number; created_at: number; cwd: string | null; parent_session_id: string | null
      seed_length: number | null; origin: string | null; delegation_depth: number | null; agent_preset: string | null; owner_id: string; title?: string
    } & RowDataPacket>>(
      `SELECT * FROM dsh_session_persistence_sessions WHERE owner_kind = 'user'
       ${requestedUser === undefined ? '' : 'AND owner_id = ?'} ${requestedSession === undefined ? '' : 'AND session_id = ?'}
       ORDER BY updated_at, session_id`, [
        ...requestedUser === undefined ? [] : [requestedUser], ...requestedSession === undefined ? [] : [requestedSession],
      ],
    )
    let migrated = 0
    let skipped = 0
    for (const session of sessions) {
      const [records] = await pool.query<Array<{
        payload: Buffer | string; codec: string; checksum: Buffer | string; seq_from: number; event_count: number
      } & RowDataPacket>>(
        'SELECT payload, codec, checksum, seq_from, event_count FROM dsh_session_persistence_records WHERE session_id = ? ORDER BY seq_from',
        [session.session_id],
      )
      const events = decodeRows(records)
      const rows = messageRows(events)
      if (rows.length === 0) { skipped += 1; continue }
      const title = [...events].reverse().find(event => event.type === 'session/title')
      const titleData = title?.type === 'session/title' ? title.data : undefined
      if (dryRun) {
        console.log(JSON.stringify({ sessionId: session.session_id, userId: session.owner_id, messages: rows.length, title: titleData?.title ?? null }))
        migrated += 1
        continue
      }
      await pool.query('START TRANSACTION')
      try {
        await pool.query(
          `INSERT INTO ${CONVERSATIONS_TABLE}
           (session_id, version, user_id, title, title_status, title_source, title_revision,
            title_updated_at, status, cwd, parent_session_id, seed_length, origin, delegation_depth, agent_preset,
            incarnation, revision, next_message_ordinal, extensions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 0, ?, '{}', ?, ?)
           ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
          [session.session_id, SESSION_FORMAT_VERSION, session.owner_id, titleData?.title ?? '',
            titleData?.source.kind === 'user' ? 'manual' : titleData?.source.kind === 'provider' ? 'generated' : 'fallback',
            titleData?.source.kind ?? 'fallback', title?.time ?? session.created_at, session.cwd,
            session.parent_session_id, session.seed_length, session.origin, session.delegation_depth,
            session.agent_preset, randomUUID(), rows.length, session.created_at, Date.now()],
        )
        let ordinal = 0
        for (const row of rows) {
          await pool.query(
            `INSERT IGNORE INTO ${MESSAGES_TABLE}
             (message_id, session_id, ordinal, event_type, role, turn_no, step_no, content_json, source_json,
              tool_call_id, usage_json, visibility, status, extensions, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.messageId, session.session_id, ordinal++, row.eventType, row.role, row.turnNo, row.stepNo,
              JSON.stringify(row.content), JSON.stringify(row.source), row.toolCallId, row.usage === null ? null : JSON.stringify(row.usage),
              row.visibility, row.status, JSON.stringify(row.extensions), row.createdAt, row.createdAt],
          )
          await pool.query(
            `INSERT INTO ${OUTBOX_TABLE}
             (outbox_id, schema_version, event_type, aggregate_type, aggregate_id, user_id, session_id,
              message_id, aggregate_revision, payload_json, extensions, occurred_at)
             VALUES (?, 1, 'conversation.message.committed', 'conversation', ?, ?, ?, ?, ?, ?, '{}', ?)`,
            [randomUUID(), session.session_id, session.owner_id, session.session_id, row.messageId, ordinal, JSON.stringify({ role: row.role, status: row.status }), row.createdAt],
          )
        }
        await pool.query(`UPDATE ${CONVERSATIONS_TABLE} SET next_message_ordinal = ?, revision = revision + 1 WHERE session_id = ?`, [rows.length, session.session_id])
        await pool.query('COMMIT')
        migrated += 1
      } catch (error) {
        await pool.query('ROLLBACK')
        throw error
      }
    }
    console.log(JSON.stringify({ dryRun, schemaVersion: SCHEMA_VERSION, migrated, skipped }))
  } finally {
    await pool.end()
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
