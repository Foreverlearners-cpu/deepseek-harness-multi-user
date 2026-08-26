import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Mysql, { type Config as MysqlConfig, type MysqlConnection } from '@deepseek-ai/dsh-mysql'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import ConversationMysql from '../../conversation-mysql/src/index.ts'
import ConversationPersistence from '../../conversation-persistence/src/index.ts'
import ConversationStarter, { stableSessionIdentity } from '../../conversation-starter/src/index.ts'
import ConversationWeb from '../src/index.ts'

const target = process.env.DSH_MYSQL_TEST_URL
const contexts: Context[] = []

function targetConfig(): MysqlConfig {
  const url = new URL(target!)
  return {
    host: url.hostname,
    port: url.port === '' ? 3306 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectionLimit: 4,
  }
}

async function clean(connection: MysqlConnection, tenantId: string): Promise<void> {
  for (const table of ['dsh_subagent_runs', 'dsh_conversation_message_state', 'dsh_conversation_messages', 'dsh_agent_records', 'dsh_conversations']) {
    await connection.query(`DELETE FROM ${table} WHERE tenant_id = ?`, [tenantId])
  }
}

afterEach(async () => Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())))

describe.skipIf(target === undefined)('real MySQL Web conversation composition', () => {
  it('creates the schema and stores complete Web messages without chunks', async () => {
    const suffix = randomUUID()
    const tenantId = `web-tenant-${suffix}`
    const userId = `web-user-${suffix}`
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Mysql, targetConfig())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ConversationMysql)
    await ctx.plugin(ConversationPersistence, { maxDelayMs: 10_000 })
    await ctx.plugin(ConversationStarter, { tenantId, localUserId: userId })
    await ctx.plugin(ConversationWeb)
    await ctx.plugin(AgentLoop, { agents: [] })

    try {
      const id = SessionId(`web-mysql-${suffix}`)
      const handle = await ctx.agents.create({ sessionId: id, setup: ctx.conversationWeb.compose() })
      handle.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `MYSQL-PROBE-${suffix}` }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      handle.agent.session.append('assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `CHUNK-${suffix}` },
      })
      await ctx.conversationPersistence.flush(handle.agent.session)

      await ctx.mysql.connection(async (connection) => {
        const [schema] = await connection.query<Array<{ schema_name: string; version: number }>>(
          'SELECT schema_name, version FROM dsh_conversation_schema WHERE schema_name = ?', ['conversation'],
        )
        expect(schema).toEqual([{ schema_name: 'conversation', version: 1 }])
        const [messages] = await connection.query<Array<{ visible_text: string }>>(
          'SELECT visible_text FROM dsh_conversation_messages WHERE tenant_id = ? AND visible_text = ?',
          [tenantId, `MYSQL-PROBE-${suffix}`],
        )
        expect(messages).toEqual([{ visible_text: `MYSQL-PROBE-${suffix}` }])
        const identity = stableSessionIdentity(id)
        const [chunks] = await connection.query<Array<{ count: number }>>(
          'SELECT COUNT(*) AS count FROM dsh_agent_records WHERE tenant_id = ? AND conversation_id = ? AND record_type LIKE ?',
          [tenantId, identity.conversationId, '%chunk%'],
        )
        expect(Number(chunks[0]?.count)).toBe(0)
      })
    } finally {
      await ctx.mysql.connection(connection => clean(connection, tenantId))
    }
  })
})
