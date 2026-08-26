import { Context } from '@deepseek-ai/cordis'
import Mysql, { type Config, type MysqlConnection } from '@deepseek-ai/dsh-mysql'
import {
  agentRecordId,
  conversationId,
  conversationMessageId,
  conversationSessionId,
  conversationTenantId,
  conversationUserId,
  delegationId,
  type AgentRecord,
  type ConversationIdentity,
} from '@deepseek-ai/dsh-conversation'
import { afterEach, describe, expect, it } from 'vitest'
import type { RowDataPacket } from 'mysql2/promise'
import { runConversationContract } from '../../conversation/tests/contract.ts'
import ConversationMysql from '../src/index.ts'

const target = process.env.DSH_MYSQL_TEST_URL
interface OwnedContext {
  readonly ctx: Context
  readonly owners: readonly (readonly [string, string])[]
}

const contexts: OwnedContext[] = []

function targetConfig(): Config {
  const url = new URL(target!)
  if (url.protocol !== 'mysql:') throw new Error('DSH_MYSQL_TEST_URL must use mysql:')
  return {
    host: url.hostname,
    port: url.port === '' ? 3306 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectionLimit: 4,
  }
}

async function cleanOwner(connection: MysqlConnection, owner: readonly [string, string]): Promise<void> {
  const values: [string, string] = [owner[0], owner[1]]
  const [tables] = await connection.query<(RowDataPacket & { table_name: string })[]>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
       ('dsh_conversation_message_files', 'dsh_conversation_files', 'dsh_file_objects')`,
  )
  const available = new Set(tables.map(row => row.table_name))
  if (available.has('dsh_conversation_message_files')) {
    await connection.query('DELETE FROM dsh_conversation_message_files WHERE tenant_id = ? AND user_id = ?', values)
  }
  if (available.has('dsh_conversation_files')) {
    await connection.query('DELETE FROM dsh_conversation_files WHERE tenant_id = ? AND user_id = ?', values)
  }
  if (available.has('dsh_file_objects')) {
    await connection.query('DELETE FROM dsh_file_objects WHERE tenant_id = ? AND user_id = ?', values)
  }
  await connection.query('DELETE FROM dsh_subagent_runs WHERE tenant_id = ? AND user_id = ?', values)
  await connection.query('DELETE FROM dsh_conversation_message_state WHERE tenant_id = ? AND user_id = ?', values)
  await connection.query('DELETE FROM dsh_conversation_messages WHERE tenant_id = ? AND user_id = ?', values)
  await connection.query('DELETE FROM dsh_agent_records WHERE tenant_id = ? AND user_id = ?', values)
  await connection.query('DELETE FROM dsh_conversations WHERE tenant_id = ? AND user_id = ?', values)
}

async function fresh(
  owners: readonly (readonly [string, string])[] = [],
  cleanFirst = true,
): Promise<Context> {
  const ctx = new Context()
  contexts.push({ ctx, owners })
  await ctx.plugin(Mysql, targetConfig())
  await ctx.plugin(ConversationMysql)
  if (cleanFirst) {
    await ctx.mysql.connection(async (connection) => {
      for (const owner of owners) await cleanOwner(connection, owner)
    })
  }
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ({ ctx, owners }) => {
    await ctx.mysql.connection(async (connection) => {
      for (const owner of owners) await cleanOwner(connection, owner)
    })
    await ctx.fiber.dispose()
  }))
})

describe.skipIf(target === undefined)('real MySQL conversation provider contract', () => {
  runConversationContract('mysql e2e', async () => {
    const ctx = await fresh([['tenant-1', 'user-1']])
    return { ctx, conversations: ctx.conversations }
  })

  it('keeps the CDC-facing message table at the exact consumer schema', async () => {
    const ctx = await fresh()
    const columns = await ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dsh_conversation_messages'
         ORDER BY ORDINAL_POSITION`,
      )
      return rows.map(row => row.column_name)
    })
    expect(columns).toEqual([
      'tenant_id', 'user_id', 'session_id', 'message_id', 'revision',
      'status', 'visibility', 'role', 'visible_text', 'occurred_at',
    ])
  })

  it('batches 300 records, retries exactly, and reads them after restart', async () => {
    const owner = ['batch-tenant', 'batch-user'] as const
    let ctx = await fresh([owner])
    const identity = {
      tenantId: conversationTenantId('batch-tenant'),
      userId: conversationUserId('batch-user'),
      conversationId: conversationId('batch-conversation'),
    }
    await ctx.conversations.create({
      ...identity,
      sessionId: conversationSessionId('batch-session'),
      origin: 'top-level',
      delegationDepth: 0,
    })
    const records = Array.from({ length: 300 }, (_, index): AgentRecord => ({
      ...identity,
      recordId: agentRecordId(`batch-record-${String(index + 1)}`),
      sequence: index + 1,
      sourceSequence: index + 1,
      type: 'user/message',
      status: 'completed',
      payload: {
        messageId: conversationMessageId(`batch-message-${String(index + 1)}`),
        visibility: 'user',
        text: `line ${String(index + 1)}`,
      },
      occurredAt: 10_000 + index,
      extensions: {},
    }))
    const request = { ...identity, expectedNextSequence: 1, records }
    const commit = await ctx.conversations.append(request)
    await expect(ctx.conversations.append(request)).resolves.toEqual(commit)
    await ctx.fiber.dispose()
    const contextIndex = contexts.findIndex(entry => entry.ctx === ctx)
    if (contextIndex >= 0) contexts.splice(contextIndex, 1)

    ctx = await fresh([owner], false)
    const page = await ctx.conversations.records({ ...identity, limit: 1_000 })
    const messages = await ctx.conversations.messages({ ...identity, limit: 1_000 })
    expect(page.records).toHaveLength(300)
    expect(messages.messages).toHaveLength(300)
    expect((await ctx.conversations.get(identity))).toMatchObject({ revision: 2, nextSequence: 301 })
  })

  it('rolls records and messages back when a later projection fails', async () => {
    const ctx = await fresh([['rollback-tenant', 'rollback-user']])
    const identity: ConversationIdentity = {
      tenantId: conversationTenantId('rollback-tenant'),
      userId: conversationUserId('rollback-user'),
      conversationId: conversationId('rollback-conversation'),
    }
    await ctx.conversations.create({
      ...identity, sessionId: conversationSessionId('rollback-session'), origin: 'top-level', delegationDepth: 0,
    })
    const records: AgentRecord[] = [{
      ...identity,
      recordId: agentRecordId('rollback-record-1'),
      sequence: 1,
      sourceSequence: 1,
      type: 'user/message',
      status: 'completed',
      payload: { messageId: conversationMessageId('rollback-message'), visibility: 'user', text: 'must roll back' },
      occurredAt: 20_001,
      extensions: {},
    }, {
      ...identity,
      recordId: agentRecordId('rollback-record-2'),
      sequence: 2,
      sourceSequence: 2,
      type: 'subagent/completed',
      status: 'completed',
      payload: { delegationId: delegationId('missing-delegation'), outcome: 'failed' },
      occurredAt: 20_002,
      extensions: {},
    }]
    await expect(ctx.conversations.append({ ...identity, expectedNextSequence: 1, records }))
      .rejects.toMatchObject({ code: 'record-conflict' })
    await expect(ctx.conversations.records(identity)).resolves.toEqual({ records: [] })
    await expect(ctx.conversations.messages(identity)).resolves.toEqual({ messages: [] })
    await expect(ctx.conversations.get(identity)).resolves.toMatchObject({ revision: 1, nextSequence: 1 })
  })
})
