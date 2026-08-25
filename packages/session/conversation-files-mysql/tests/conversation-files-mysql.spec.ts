import { Context } from '@deepseek-ai/cordis'
import {
  agentRecordId,
  conversationId,
  conversationTenantId,
  conversationToolCallId,
  conversationUserId,
  type Conversation,
} from '@deepseek-ai/dsh-conversation'
import type { ConversationRecordDraft } from '@deepseek-ai/dsh-conversation-persistence'
import { afterEach, describe, expect, it } from 'vitest'
import ConversationFilesMysql from '../src/index.ts'
import {
  FakeConversationPersistence,
  FakeFilesMysql,
  FakeFileStorage,
  provideFakes,
} from './fake-services.ts'

const contexts: Context[] = []
const identity = {
  tenantId: conversationTenantId('tenant'),
  userId: conversationUserId('user'),
  conversationId: conversationId('conversation'),
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

async function plugin(threshold = 10): Promise<{
  ctx: Context
  mysql: FakeFilesMysql
  storage: FakeFileStorage
  persistence: FakeConversationPersistence
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const order: string[] = []
  const mysql = new FakeFilesMysql(order)
  const storage = new FakeFileStorage(order)
  const persistence = new FakeConversationPersistence()
  provideFakes(ctx, mysql, storage, persistence)
  await ctx.plugin(ConversationFilesMysql, { toolResultObjectThresholdBytes: threshold })
  return { ctx, mysql, storage, persistence }
}

function conversation(): Conversation {
  return {
    ...identity,
    sessionId: 'session' as Conversation['sessionId'],
    origin: 'top-level',
    delegationDepth: 0,
    status: 'active',
    revision: 1,
    nextSequence: 1,
    retention: { kind: 'permanent' },
    createdAt: 1,
    updatedAt: 1,
    extensions: {},
  }
}

function draft(result: string): ConversationRecordDraft {
  return {
    recordId: agentRecordId('record'),
    sourceSequence: 1,
    type: 'tool/result',
    status: 'completed',
    payload: {
      toolCallId: conversationToolCallId('call'),
      outcome: 'completed',
      result,
    },
    occurredAt: 1,
    extensions: {},
  }
}

describe('conversation file metadata publication', () => {
  it('publishes immutable bytes before beginning the metadata transaction', async () => {
    const { ctx, mysql, storage } = await plugin()
    await ctx.conversationFiles.publish({
      ...identity,
      fileId: 'file' as Parameters<typeof ctx.conversationFiles.publish>[0]['fileId'],
      content: (async function * () { yield Buffer.from('content') })(),
      mediaType: 'text/plain',
    })

    expect(storage.order).toEqual(['put', 'begin'])
    expect(storage.puts).toBe(1)
    expect(mysql).toMatchObject({ begins: 1, commits: 1, rollbacks: 0 })
  })

  it('rolls back only metadata when the database rejects an already published object', async () => {
    const { ctx, mysql, storage } = await plugin()
    mysql.failFileInsert = true
    await expect(ctx.conversationFiles.publish({
      ...identity,
      fileId: 'file' as Parameters<typeof ctx.conversationFiles.publish>[0]['fileId'],
      content: (async function * () { yield Buffer.from('content') })(),
      mediaType: 'text/plain',
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    expect(storage.puts).toBe(1)
    expect(mysql).toMatchObject({ begins: 1, commits: 0, rollbacks: 1 })
  })
})

describe('tool result record preparer', () => {
  it('keeps JSON equal to the byte threshold inline', async () => {
    const { persistence, storage } = await plugin(10)
    await expect(persistence.preparer?.({ session: {} as never, conversation: conversation(), draft: draft('12345678') }))
      .resolves.toBeUndefined()
    expect(storage.puts).toBe(0)
  })

  it('externalizes JSON strictly above the threshold with a deterministic file id', async () => {
    const { persistence, storage } = await plugin(10)
    const first = await persistence.preparer?.({ session: {} as never, conversation: conversation(), draft: draft('123456789') })
    expect(first?.type).toBe('tool/result')
    const fileId = first?.type === 'tool/result' ? first.payload.resultFileId : undefined
    expect(fileId).toMatch(/^tool-result~[0-9a-f]{64}$/)
    expect(first?.type === 'tool/result' && 'result' in first.payload).toBe(false)
    expect(storage.puts).toBe(1)
  })
})
