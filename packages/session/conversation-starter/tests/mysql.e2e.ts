import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import Mysql, { type Config as MysqlConfig, type MysqlConnection } from '@deepseek-ai/dsh-mysql'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import ConversationMysql from '../../conversation-mysql/src/index.ts'
import ConversationPersistence from '../../conversation-persistence/src/index.ts'
import ConversationStarter, { stableSessionIdentity } from '../src/index.ts'

const target = process.env.DSH_MYSQL_TEST_URL
interface TestContext { readonly ctx: Context; readonly tenantId: string; readonly userId: string }
const contexts: TestContext[] = []

function targetConfig(): MysqlConfig {
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

async function cleanOwner(connection: MysqlConnection, tenantId: string, userId: string): Promise<void> {
  await connection.query('DELETE FROM dsh_conversation_files WHERE tenant_id = ? AND user_id = ?', [tenantId, userId])
  await connection.query('DELETE FROM dsh_subagent_runs WHERE tenant_id = ? AND user_id = ?', [tenantId, userId])
  await connection.query('DELETE FROM dsh_conversation_message_state WHERE tenant_id = ? AND user_id = ?', [tenantId, userId])
  await connection.query('DELETE FROM dsh_conversation_messages WHERE tenant_id = ? AND user_id = ?', [tenantId, userId])
  await connection.query('DELETE FROM dsh_agent_records WHERE tenant_id = ? AND user_id = ?', [tenantId, userId])
  await connection.query('DELETE FROM dsh_conversations WHERE tenant_id = ? AND user_id = ?', [tenantId, userId])
}

async function boot(tenantId: string, userId: string): Promise<Context> {
  const ctx = new Context()
  contexts.push({ ctx, tenantId, userId })
  await ctx.plugin(Mysql, targetConfig())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ConversationMysql)
  await ctx.plugin(ConversationPersistence, { maxDelayMs: 10_000 })
  await ctx.plugin(ConversationStarter, { tenantId, localUserId: userId })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

async function dispose(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
  const index = contexts.findIndex(entry => entry.ctx === ctx)
  if (index >= 0) contexts.splice(index, 1)
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ({ ctx, tenantId, userId }) => {
    const mysql = ctx.get('mysql')
    if (mysql !== undefined) await mysql.connection(connection => cleanOwner(connection, tenantId, userId))
    await ctx.fiber.dispose()
  }))
})

describe.skipIf(target === undefined)('real MySQL local conversation starter', () => {
  it('persists complete messages, resumes idempotently, and inherits child ownership', async () => {
    const suffix = randomUUID()
    const tenantId = `starter-tenant-${suffix}`
    const userId = `starter-user-${suffix}`
    const rootId = SessionId(`starter-root-${suffix}`)
    const rootIdentity = stableSessionIdentity(rootId)
    let ctx = await boot(tenantId, userId)
    const root = await ctx.agents.create({ sessionId: rootId, setup: ctx.conversationStarter.compose() })
    root.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    root.agent.session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial must not persist' },
    })
    root.agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'complete answer' }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    await ctx.sessions.flush(root.agent.session)
    const seed: readonly SessionEvent[] = structuredClone(root.agent.session.events)
    const first = await ctx.conversations.records({
      tenantId: ctx.conversationStarter.tenantId,
      userId: ctx.conversationStarter.localUserId,
      conversationId: rootIdentity.conversationId,
      limit: 100,
    })
    expect(first.records.map(record => record.type)).toEqual(['user/message', 'assistant/message'])
    expect(JSON.stringify(first.records)).not.toContain('partial must not persist')
    await dispose(ctx)

    ctx = await boot(tenantId, userId)
    const resumed = await ctx.agents.create({
      sessionId: rootId,
      seed,
      setup: ctx.conversationStarter.compose(),
    })
    await ctx.sessions.flush(resumed.agent.session)
    const afterResume = await ctx.conversations.records({
      tenantId: ctx.conversationStarter.tenantId,
      userId: ctx.conversationStarter.localUserId,
      conversationId: rootIdentity.conversationId,
      limit: 100,
    })
    expect(afterResume.records.map(record => record.type)).toEqual(['user/message', 'assistant/message'])

    const childId = SessionId(`starter-child-${suffix}`)
    await ctx.agents.create({
      sessionId: childId,
      meta: { parentSession: rootId, origin: 'subagent', delegationDepth: 1 },
      setup: ctx.conversationStarter.compose(),
    })
    const childIdentity = stableSessionIdentity(childId)
    const child = await ctx.conversations.get({
      tenantId: ctx.conversationStarter.tenantId,
      userId: ctx.conversationStarter.localUserId,
      conversationId: childIdentity.conversationId,
    })
    expect(child).toMatchObject({
      tenantId,
      userId,
      parentConversationId: rootIdentity.conversationId,
      origin: 'subagent',
      delegationDepth: 1,
      retention: { kind: 'permanent' },
    })
  })

  it('publishes neither malformed lineage nor a child with a missing parent', async () => {
    const suffix = randomUUID()
    const ctx = await boot(`starter-tenant-${suffix}`, `starter-user-${suffix}`)
    const forkId = SessionId(`starter-fork-${suffix}`)
    await expect(ctx.agents.create({
      sessionId: forkId,
      meta: { parentSession: SessionId(`starter-parent-${suffix}`) },
      setup: ctx.conversationStarter.compose(),
    })).rejects.toThrow('without origin="subagent"')
    expect(ctx.sessions.get(forkId)).toBeUndefined()

    const orphanId = SessionId(`starter-orphan-${suffix}`)
    await expect(ctx.agents.create({
      sessionId: orphanId,
      meta: { parentSession: SessionId(`starter-missing-${suffix}`), origin: 'subagent', delegationDepth: 1 },
      setup: ctx.conversationStarter.compose(),
    })).rejects.toMatchObject({ code: 'conversation-not-found' })
    expect(ctx.sessions.get(orphanId)).toBeUndefined()
  })
})
