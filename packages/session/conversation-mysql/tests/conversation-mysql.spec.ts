import { Context } from '@deepseek-ai/cordis'
import {
  agentRecordId,
  conversationId,
  conversationTenantId,
  conversationToolCallId,
  conversationUserId,
  type AgentRecord,
} from '@deepseek-ai/dsh-conversation'
import { afterEach, describe, expect, it } from 'vitest'
import ConversationMysql from '../src/index.ts'
import { FakeConversationMysql } from './fake-mysql.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

function records(count: number): AgentRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    tenantId: conversationTenantId('fake-tenant'),
    userId: conversationUserId('fake-user'),
    conversationId: conversationId('fake-conversation'),
    recordId: agentRecordId(`fake-record-${String(index + 1)}`),
    sequence: index + 1,
    sourceSequence: index + 1,
    type: 'tool/call',
    status: 'completed',
    payload: {
      toolCallId: conversationToolCallId(`fake-call-${String(index + 1)}`),
      toolName: 'inspect',
      arguments: {},
      effect: 'read-only',
    },
    occurredAt: 30_000 + index,
    extensions: {},
  }))
}

async function provider(fake: FakeConversationMysql): Promise<ConversationMysql> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', fake.asService())
  await ctx.plugin(ConversationMysql)
  return ctx.conversations as ConversationMysql
}

describe('conversation MySQL transaction batching', () => {
  it('writes 300 records in five multi-value statements and one transaction', async () => {
    const fake = new FakeConversationMysql()
    const conversations = await provider(fake)
    await conversations.append({
      tenantId: conversationTenantId('fake-tenant'),
      userId: conversationUserId('fake-user'),
      conversationId: conversationId('fake-conversation'),
      expectedNextSequence: 1,
      records: records(300),
    })

    expect(fake.queries.filter(sql => sql.startsWith('INSERT INTO dsh_agent_records'))).toHaveLength(5)
    expect(fake).toMatchObject({ begins: 1, commits: 1, rollbacks: 0 })
  })

  it('rolls the outer transaction back when a later record batch fails', async () => {
    const fake = new FakeConversationMysql()
    fake.failRecordInsert = 3
    const conversations = await provider(fake)

    await expect(conversations.append({
      tenantId: conversationTenantId('fake-tenant'),
      userId: conversationUserId('fake-user'),
      conversationId: conversationId('fake-conversation'),
      expectedNextSequence: 1,
      records: records(300),
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
    expect(fake).toMatchObject({ begins: 1, commits: 0, rollbacks: 1 })
  })
})
