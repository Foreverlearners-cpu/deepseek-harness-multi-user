import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  agentRecordId,
  conversationFileId,
  conversationId,
  conversationMessageId,
  conversationSessionId,
  conversationTenantId,
  conversationToolCallId,
  conversationUserId,
  type AgentRecord,
  type Conversation,
} from '@deepseek-ai/dsh-conversation'
import type { ConversationRecordDraft } from '@deepseek-ai/dsh-conversation-persistence'
import LocalFileStorage from '@deepseek-ai/dsh-file-storage-local'
import Mysql, { type Config, type MysqlConnection } from '@deepseek-ai/dsh-mysql'
import { afterEach, describe, expect, it } from 'vitest'
import type { RowDataPacket } from 'mysql2/promise'
import ConversationMysql from '../../conversation-mysql/src/index.ts'
import ConversationFilesMysql from '../src/index.ts'
import { FakeConversationPersistence } from './fake-services.ts'

const target = process.env.DSH_MYSQL_TEST_URL
const contexts: Context[] = []
const roots: string[] = []
const suffix = `${String(process.pid)}-${Date.now().toString(36)}`
const identity = {
  tenantId: conversationTenantId(`files-tenant-${suffix}`),
  userId: conversationUserId(`files-user-${suffix}`),
  conversationId: conversationId(`files-conversation-${suffix}`),
}

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

async function fresh(root: string): Promise<{ ctx: Context; persistence: FakeConversationPersistence }> {
  const ctx = new Context()
  contexts.push(ctx)
  const persistence = new FakeConversationPersistence()
  await ctx.plugin(Mysql, targetConfig())
  await ctx.plugin(ConversationMysql)
  await ctx.plugin(LocalFileStorage, { root })
  ctx.provide('conversationPersistence', persistence.asService())
  await ctx.plugin(ConversationFilesMysql)
  return { ctx, persistence }
}

async function cleanup(connection: MysqlConnection): Promise<void> {
  const owner = [identity.tenantId, identity.userId]
  await connection.execute('DELETE FROM dsh_conversation_message_files WHERE tenant_id = ? AND user_id = ?', owner)
  await connection.execute('DELETE FROM dsh_conversation_files WHERE tenant_id = ? AND user_id = ?', owner)
  await connection.execute('DELETE FROM dsh_file_objects WHERE tenant_id = ? AND user_id = ?', owner)
  await connection.execute('DELETE FROM dsh_conversation_message_state WHERE tenant_id = ? AND user_id = ?', owner)
  await connection.execute('DELETE FROM dsh_conversation_messages WHERE tenant_id = ? AND user_id = ?', owner)
  await connection.execute('DELETE FROM dsh_subagent_runs WHERE tenant_id = ? AND user_id = ?', owner)
  await connection.execute('DELETE FROM dsh_agent_records WHERE tenant_id = ? AND user_id = ?', owner)
  await connection.execute('DELETE FROM dsh_conversations WHERE tenant_id = ? AND user_id = ?', owner)
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of content) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function conversation(value: Conversation): Conversation {
  return value
}

afterEach(async () => {
  for (const ctx of contexts) {
    await ctx.mysql?.connection(cleanup).catch(() => undefined)
    await ctx.fiber.dispose()
  }
  contexts.length = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(target === undefined)('real MySQL conversation file metadata', () => {
  it('persists owner-scoped files, message links, and local objects across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-conversation-files-mysql-'))
    roots.push(root)
    let runtime = await fresh(root)
    const created = await runtime.ctx.conversations.create({
      ...identity,
      sessionId: conversationSessionId(`files-session-${suffix}`),
      origin: 'top-level',
      delegationDepth: 0,
    })
    const messageId = conversationMessageId(`files-message-${suffix}`)
    const record: AgentRecord = {
      ...identity,
      recordId: agentRecordId(`files-record-${suffix}`),
      sequence: 1,
      sourceSequence: 1,
      type: 'user/message',
      status: 'completed',
      payload: { messageId, visibility: 'user', text: 'file owner' },
      occurredAt: Date.now(),
      extensions: {},
    }
    await runtime.ctx.conversations.append({ ...identity, expectedNextSequence: 1, records: [record] })
    const fileId = conversationFileId(`files-file-${suffix}`)
    const bytes = Buffer.from('durable conversation object')
    const published = await runtime.ctx.conversationFiles.publish({
      ...identity,
      fileId,
      content: (async function * () { yield bytes })(),
      mediaType: 'text/plain',
      fileName: 'answer.txt',
      messageId,
    })
    await expect(runtime.ctx.conversationFiles.publish({
      ...identity,
      fileId,
      content: (async function * () { yield bytes })(),
      mediaType: 'text/plain',
      fileName: 'answer.txt',
      messageId,
    })).resolves.toEqual(published)
    expect(await runtime.ctx.conversationFiles.get({
      ...identity,
      userId: conversationUserId(`other-${suffix}`),
      fileId,
    })).toBeUndefined()
    await runtime.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(runtime.ctx), 1)

    runtime = await fresh(root)
    const opened = await runtime.ctx.conversationFiles.open({ ...identity, fileId })
    expect(await collect(opened.content)).toEqual(bytes)
    await expect(runtime.ctx.conversationFiles.listMessageFiles({ ...identity, messageId }))
      .resolves.toMatchObject({ files: [{ fileId, mediaType: 'text/plain', fileName: 'answer.txt' }] })
    expect(conversation(created)).toMatchObject(identity)
  })

  it('externalizes oversized complete tool JSON and leaves no chunk metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-conversation-files-mysql-'))
    roots.push(root)
    const { ctx, persistence } = await fresh(root)
    const created = await ctx.conversations.create({
      ...identity,
      sessionId: conversationSessionId(`files-session-${suffix}`),
      origin: 'top-level',
      delegationDepth: 0,
    })
    const draft: ConversationRecordDraft = {
      recordId: agentRecordId(`large-result-${suffix}`),
      sourceSequence: 1,
      type: 'tool/result',
      status: 'completed',
      payload: {
        toolCallId: conversationToolCallId(`large-call-${suffix}`),
        outcome: 'completed',
        result: { text: 'x'.repeat(262_144) },
      },
      occurredAt: Date.now(),
      extensions: {},
    }
    const prepared = await persistence.preparer?.({ session: {} as never, conversation: conversation(created), draft })
    if (prepared?.type !== 'tool/result' || prepared.payload.resultFileId === undefined) {
      throw new Error('oversized result was not externalized')
    }
    expect('result' in prepared.payload).toBe(false)
    const opened = await ctx.conversationFiles.open({ ...identity, fileId: prepared.payload.resultFileId })
    const stored = await collect(opened.content)
    expect(stored.byteLength).toBeGreaterThan(262_144)
    expect(JSON.parse(stored.toString('utf8'))).toEqual(draft.payload.result)

    const [tables] = await ctx.mysql.connection(async connection => connection.query<(RowDataPacket & { name: string })[]>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'dsh_conversation%chunk%'`,
    ))
    expect(tables).toEqual([])
  })

  it('keeps an immutable local orphan when conversation ownership validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-conversation-files-mysql-'))
    roots.push(root)
    const { ctx } = await fresh(root)
    const bytes = Buffer.from('orphan after metadata rejection')
    await expect(ctx.conversationFiles.publish({
      ...identity,
      fileId: conversationFileId(`orphan-${suffix}`),
      content: (async function * () { yield bytes })(),
      mediaType: 'application/octet-stream',
    })).rejects.toMatchObject({ code: 'conversation-not-found' })

    const digest = createHash('sha256').update(bytes).digest('hex')
    await expect(readFile(join(root, 'objects', 'sha256', digest.slice(0, 2), digest.slice(2, 4), digest)))
      .resolves.toEqual(bytes)
    await expect(ctx.conversationFiles.list(identity)).resolves.toEqual({ files: [] })
  })
})
