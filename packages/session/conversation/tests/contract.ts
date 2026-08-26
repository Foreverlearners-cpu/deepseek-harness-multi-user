/** Shared semantic conversation Provider conformance suite. */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type ConversationService from '../src/index.ts'
import {
  agentRecordId,
  conversationId,
  conversationMessageId,
  conversationSessionId,
  conversationTenantId,
  conversationTurnId,
  conversationUserId,
  delegationId,
  type AgentRecord,
  type ConversationIdentity,
} from '../src/index.ts'

/** Fresh Provider service used for one conformance case. */
export interface ConversationContractHarness {
  readonly ctx: Context
  readonly conversations: ConversationService
}

const owner = {
  tenantId: conversationTenantId('tenant-1'),
  userId: conversationUserId('user-1'),
}

function identity(value = 'conversation-1'): ConversationIdentity {
  return { ...owner, conversationId: conversationId(value) }
}

function record(
  conversation: ConversationIdentity,
  sequence: number,
  value: Pick<AgentRecord, 'type' | 'status' | 'payload'>,
): AgentRecord {
  return {
    ...conversation,
    recordId: agentRecordId(`record-${String(sequence)}`),
    sequence,
    sourceSequence: 100 + sequence,
    occurredAt: 2_000 + sequence,
    extensions: {},
    ...value,
  } as AgentRecord
}

/** Run the shared ordering, idempotency, projection, and isolation contract. */
export function runConversationContract(
  label: string,
  create: () => Promise<ConversationContractHarness>,
): void {
  describe(`conversation contract: ${label}`, () => {
    it('creates permanent conversations and returns tenant-user pages', async () => {
      const { conversations } = await create()
      const firstIdentity = identity('list-conversation-1')
      const first = await conversations.create({
        ...firstIdentity,
        sessionId: conversationSessionId('list-session-1'),
        origin: 'top-level',
        delegationDepth: 0,
        title: 'First',
      })
      await conversations.create({
        ...identity('list-conversation-2'), sessionId: conversationSessionId('list-session-2'), origin: 'top-level', delegationDepth: 0,
      })

      expect(first).toMatchObject({
        ...firstIdentity,
        status: 'active',
        revision: 1,
        nextSequence: 1,
        retention: { kind: 'permanent' },
      })
      expect(await conversations.get(firstIdentity)).toEqual(first)
      expect(await conversations.get(identity('missing'))).toBeUndefined()
      const pageOne = await conversations.list({ ...owner, limit: 1 })
      const pageTwo = await conversations.list({ ...owner, limit: 1, cursor: pageOne.nextCursor! })
      expect(pageOne.conversations.map(value => value.conversationId)).toEqual(['list-conversation-1'])
      expect(pageTwo.conversations.map(value => value.conversationId)).toEqual(['list-conversation-2'])
    })

    it('atomically appends contiguous records and makes exact retries idempotent', async () => {
      const { conversations } = await create()
      const target = identity('append-conversation')
      await conversations.create({
        ...target, sessionId: conversationSessionId('append-session'), origin: 'top-level', delegationDepth: 0,
      })
      const records: AgentRecord[] = [
        record(target, 1, {
          type: 'user/message', status: 'completed',
          payload: { messageId: conversationMessageId('message-1'), visibility: 'internal', text: 'hello' },
        }),
        record(target, 2, {
          type: 'assistant/message', status: 'completed',
          payload: { messageId: conversationMessageId('message-2'), visibility: 'user', text: 'hi' },
        }),
        record(target, 3, {
          type: 'conversation/title', status: 'completed', payload: { title: 'Persisted title' },
        }),
      ]
      const request = { ...target, expectedNextSequence: 1, records }
      const first = await conversations.append(request)
      const retry = await conversations.append(request)

      expect(first.conversation).toMatchObject({ title: 'Persisted title', nextSequence: 4, revision: 2 })
      expect(retry).toEqual(first)
      expect((await conversations.records({ ...target })).records).toEqual(records)
      expect((await conversations.messages({ ...target })).messages).toMatchObject([
        { role: 'user', visibility: 'internal', visibleText: 'hello', ordinal: 1 },
        { role: 'assistant', visibility: 'user', visibleText: 'hi', ordinal: 2 },
      ])
      const stale = record(target, 1, {
        type: 'user/message', status: 'completed',
        payload: { messageId: conversationMessageId('stale-message'), visibility: 'user', text: 'stale' },
      })
      await expect(conversations.append({ ...target, expectedNextSequence: 1, records: [stale] }))
        .rejects.toMatchObject({ code: 'sequence-conflict' })
    })

    it('atomically accepts adjacent records projected from one source event', async () => {
      const { conversations } = await create()
      const target = identity('source-group-conversation')
      await conversations.create({
        ...target,
        sessionId: conversationSessionId('source-group-session'),
        origin: 'top-level',
        delegationDepth: 0,
      })
      const interrupted = record(target, 1, {
        type: 'assistant/interrupted',
        status: 'interrupted',
        payload: { attemptId: 'attempt-1' },
      })
      const completed = {
        ...record(target, 2, {
          type: 'turn/completed',
          status: 'completed',
          payload: { turnId: conversationTurnId('turn-1'), outcome: 'interrupted' },
        }),
        sourceSequence: interrupted.sourceSequence,
      } as AgentRecord

      await expect(conversations.append({
        ...target,
        expectedNextSequence: 1,
        records: [interrupted, completed],
      })).resolves.toMatchObject({ records: [interrupted, completed] })
    })

    it('persists interrupted attempts as metadata and tracks child conversations by reference', async () => {
      const { conversations } = await create()
      const parent = identity('subagent-parent')
      const child = identity('child-1')
      const parentSessionId = conversationSessionId('session-parent')
      const parentConversation = await conversations.attach({
        ...parent,
        sessionId: parentSessionId,
        origin: 'top-level',
        delegationDepth: 0,
      })
      const childConversation = await conversations.attach({
        sessionId: conversationSessionId('session-child'),
        conversationId: child.conversationId,
        parentSessionId,
        origin: 'subagent',
        delegationDepth: 1,
      })
      expect(parentConversation.tenantId).toBe(owner.tenantId)
      expect(childConversation).toMatchObject({ ...owner, parentConversationId: parent.conversationId })
      const delegation = delegationId('delegation-1')
      const turnId = conversationTurnId('turn-1')
      const records: AgentRecord[] = [
        record(parent, 1, {
          type: 'assistant/interrupted', status: 'interrupted',
          payload: { attemptId: 'attempt-1', errorCode: 'connection-lost', generatedCharacters: 23 },
        }),
        record(parent, 2, {
          type: 'subagent/started', status: 'completed',
          payload: { delegationId: delegation, childConversationId: child.conversationId, task: 'inspect tests' },
        }),
        record(parent, 3, {
          type: 'subagent/completed', status: 'completed',
          payload: { delegationId: delegation, outcome: 'completed', resultRecordId: agentRecordId('child-result') },
        }),
        record(parent, 4, {
          type: 'turn/completed', status: 'completed',
          payload: { turnId, outcome: 'completed' },
        }),
      ]
      await conversations.append({ ...parent, expectedNextSequence: 1, records })

      expect((await conversations.records({ ...parent, types: ['assistant/interrupted'] })).records).toEqual([records[0]])
      expect((await conversations.messages({ ...parent })).messages).toEqual([])
      expect((await conversations.subagents({ ...parent, status: 'completed' })).runs).toMatchObject([{
        delegationId: delegation,
        childConversationId: child.conversationId,
        status: 'completed',
        resultRecordId: 'child-result',
      }])
    })

    it('rejects missing conversations, empty batches, and cross-owner records', async () => {
      const { conversations } = await create()
      const target = identity('rejection-conversation')
      const createInput = {
        ...target, sessionId: conversationSessionId('rejection-session'), origin: 'top-level' as const, delegationDepth: 0,
      }
      await conversations.create(createInput)
      await expect(conversations.create(createInput))
        .rejects.toMatchObject({ code: 'conversation-conflict' })
      await expect(conversations.append({ ...identity('missing'), expectedNextSequence: 1, records: [] }))
        .rejects.toMatchObject({ code: 'conversation-not-found' })
      await expect(conversations.append({ ...target, expectedNextSequence: 1, records: [] }))
        .rejects.toMatchObject({ code: 'invalid-input' })
      const foreign = record({ ...target, userId: conversationUserId('other-user') }, 1, {
        type: 'user/message', status: 'completed',
        payload: { messageId: conversationMessageId('message-1'), visibility: 'user', text: 'foreign' },
      })
      await expect(conversations.append({ ...target, expectedNextSequence: 1, records: [foreign] }))
        .rejects.toMatchObject({ code: 'record-conflict' })
      await expect(conversations.records(identity('missing'))).rejects.toMatchObject({ code: 'conversation-not-found' })
      await expect(conversations.messages(identity('missing'))).rejects.toMatchObject({ code: 'conversation-not-found' })
      await expect(conversations.subagents(identity('missing'))).rejects.toMatchObject({ code: 'conversation-not-found' })
      await expect(conversations.attach({
        sessionId: conversationSessionId('orphan'),
        conversationId: conversationId('orphan'),
        parentSessionId: conversationSessionId('missing-parent'),
        origin: 'subagent',
        delegationDepth: 1,
      })).rejects.toMatchObject({ code: 'conversation-not-found' })
    })
  })
}
