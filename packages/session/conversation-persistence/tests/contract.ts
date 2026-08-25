import type { Context } from '@deepseek-ai/cordis'
import {
  conversationId,
  conversationSessionId,
  conversationTenantId,
  conversationUserId,
} from '@deepseek-ai/dsh-conversation'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

/** Fixture returned by a conversation-persistence composition. */
export interface ConversationPersistenceFixture {
  readonly ctx: Context
  readonly records: (conversation: string) => readonly { type: string; sourceSequence: number }[]
}

/** Run Provider-independent projection, seed, and flush obligations. */
export function runConversationPersistenceContract(
  name: string,
  create: () => Promise<ConversationPersistenceFixture>,
): void {
  describe(`conversation persistence contract: ${name}`, () => {
    it('scans constructor seed once and ignores raw assistant chunks', async () => {
      const { ctx, records } = await create()
      const message = createUserMessage({ content: [{ type: 'text', text: 'seeded' }], source: { kind: 'user' } })
      const session = ctx.sessions.create(SessionId('seed-session'), {
        seed: [{ type: 'user/message', seq: 0, time: 10, data: message, surfaceOp: 'append' }],
      })
      await ctx.conversationPersistence.attach(session, {
        tenantId: conversationTenantId('tenant'),
        userId: conversationUserId('user'),
        conversationId: conversationId('seed-conversation'),
        sessionId: conversationSessionId(session.id),
        origin: 'top-level',
        delegationDepth: 0,
      })
      session.append('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'partial' },
      })
      await ctx.sessions.flush(session)
      expect(records('seed-conversation').map(record => ({
        type: record.type,
        sourceSequence: record.sourceSequence,
      }))).toEqual([{ type: 'user/message', sourceSequence: 0 }])
    })

    it('uses flush as an immediate durability barrier', async () => {
      const { ctx, records } = await create()
      const session = ctx.sessions.create(SessionId('flush-session'))
      await ctx.conversationPersistence.attach(session, {
        tenantId: conversationTenantId('tenant'),
        userId: conversationUserId('user'),
        conversationId: conversationId('flush-conversation'),
        sessionId: conversationSessionId(session.id),
        origin: 'top-level',
        delegationDepth: 0,
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect(records('flush-conversation')).toEqual([])
      await ctx.sessions.flush(session)
      expect(records('flush-conversation')).toHaveLength(1)
    })
  })
}
