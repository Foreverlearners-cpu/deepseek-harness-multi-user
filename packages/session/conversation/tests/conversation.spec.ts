import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConversationError,
  agentRecordId,
  conversationApprovalId,
  conversationCursor,
  conversationFileId,
  conversationId,
  conversationMessageId,
  conversationSessionId,
  conversationStepId,
  conversationTenantId,
  conversationToolCallId,
  conversationTurnId,
  conversationUserId,
  delegationId,
} from '../src/index.ts'
import { runConversationContract } from './contract.ts'
import { MemoryConversationService } from './memory.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

runConversationContract('memory', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryConversationService)
  return { ctx, conversations: ctx.conversations }
})

describe('conversation identities and errors', () => {
  it('brands every public id and rejects malformed values', () => {
    const functions = [
      conversationTenantId,
      conversationUserId,
      conversationId,
      conversationSessionId,
      agentRecordId,
      conversationMessageId,
      conversationTurnId,
      conversationStepId,
      conversationToolCallId,
      conversationApprovalId,
      delegationId,
      conversationFileId,
      conversationCursor,
    ]
    for (const brand of functions) {
      expect(brand('valid-id_1')).toBe('valid-id_1')
      expect(() => brand('bad id')).toThrow(TypeError)
    }
  })

  it('exposes a stable transport-safe error category and cause', () => {
    const cause = new Error('driver detail')
    const error = new ConversationError('provider-unavailable', 'conversation: Provider failed', { cause })
    expect(error).toMatchObject({
      name: 'ConversationError',
      code: 'provider-unavailable',
      message: 'conversation: Provider failed',
      cause,
    })
  })
})
