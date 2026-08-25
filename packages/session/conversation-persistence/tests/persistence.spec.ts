import { Context } from '@deepseek-ai/cordis'
import {
  conversationId,
  conversationSessionId,
  conversationTenantId,
  conversationUserId,
} from '@deepseek-ai/dsh-conversation'
import { createAssistantMessage, createToolResultMessage, createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConversationPersistence from '../src/index.ts'
import { runConversationPersistenceContract } from './contract.ts'
import { RecordingConversationService } from './recording-provider.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function fixture(config: ConstructorParameters<typeof ConversationPersistence>[1] = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(RecordingConversationService)
  await ctx.plugin(ConversationPersistence, config)
  return {
    ctx,
    provider: ctx.conversations as RecordingConversationService,
    records: (id: string) => (ctx.conversations as RecordingConversationService).committed.get(id) ?? [],
  }
}

runConversationPersistenceContract('recording Provider', async () => fixture({ maxDelayMs: 10_000 }))

async function attached(ctx: Context, sessionName = 'session', conversationName = 'conversation') {
  const session = ctx.sessions.create(SessionId(sessionName))
  await ctx.conversationPersistence.attach(session, {
    tenantId: conversationTenantId('tenant'),
    userId: conversationUserId('user'),
    conversationId: conversationId(conversationName),
    sessionId: conversationSessionId(session.id),
    origin: 'top-level',
    delegationDepth: 0,
  })
  return session
}

describe('conversation record mapping', () => {
  it('emits interrupted only for an unfinished assistant attempt and never stores partial text', async () => {
    const { ctx, records } = await fixture({ maxDelayMs: 10_000 })
    const session = await attached(ctx)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'secret partial' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await ctx.sessions.flush(session)

    expect(records('conversation').map(record => record.type)).toEqual(['assistant/interrupted', 'turn/completed'])
    expect(JSON.stringify(records('conversation'))).not.toContain('secret partial')
    expect(new Set(records('conversation').map(record => record.sourceSequence))).toEqual(new Set([3]))
  })

  it('does not invent an interruption after a complete assistant message', async () => {
    const { ctx, records } = await fixture({ maxDelayMs: 10_000 })
    const session = await attached(ctx)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'test', model: 'test' } }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await ctx.sessions.flush(session)
    expect(records('conversation').map(record => record.type)).toEqual(['assistant/message', 'turn/completed'])
  })

  it('reads tool-result correlation from the message and preserves an empty complete result', async () => {
    const { ctx, records } = await fixture({ maxDelayMs: 10_000, toolEffects: { lookup: 'read-only' } })
    const session = await attached(ctx)
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'lookup', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: CallId('call-1'), content: [], isError: false }),
    }, { surfaceOp: 'append' })
    await ctx.sessions.flush(session)
    expect(records('conversation')[1]).toMatchObject({
      type: 'tool/result',
      payload: { toolCallId: 'call-1', outcome: 'completed', result: [{ type: 'tool-result', content: [] }] },
    })
  })
})

describe('bounded write-behind', () => {
  it('uses a fixed time window and count trigger', async () => {
    vi.useFakeTimers()
    const { ctx, provider } = await fixture({ maxDelayMs: 500, maxBatchRecords: 2 })
    const session = await attached(ctx)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await vi.advanceTimersByTimeAsync(400)
    expect(provider.starts).toEqual([])
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.starts).toEqual(['conversation'])
  })

  it('fires at the fixed deadline and measures complete UTF-8 records for the byte trigger', async () => {
    vi.useFakeTimers()
    const timed = await fixture({ maxDelayMs: 500, maxBatchRecords: 64, maxBatchBytes: 1_000_000 })
    const timedSession = await attached(timed.ctx)
    timedSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await vi.advanceTimersByTimeAsync(499)
    expect(timed.provider.starts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(timed.provider.starts).toEqual(['conversation'])

    const sized = await fixture({ maxDelayMs: 10_000, maxBatchRecords: 64, maxBatchBytes: 1 })
    const sizedSession = await attached(sized.ctx, 'sized-session', 'sized-conversation')
    sizedSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: '中' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sized.provider.starts).toEqual(['sized-conversation'])
  })

  it('makes overflow and unknown tool policy sticky admission failures', async () => {
    const { ctx } = await fixture({ maxDelayMs: 10_000, maxPendingRecords: 1 })
    const session = await attached(ctx)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await expect(ctx.sessions.flush(session)).rejects.toThrow('maxPendingRecords=1')

    const second = await attached(ctx, 'tool-session', 'tool-conversation')
    second.append('tool/call', { turn: 1, step: 1, callId: CallId('call-2'), name: 'unknown', arguments: '{}' })
    await expect(ctx.sessions.flush(second)).rejects.toThrow('no tool-effect policy classified')
  })

  it('serializes one Session while allowing two Sessions to enter the Provider concurrently', async () => {
    const { ctx, provider } = await fixture({ maxDelayMs: 10_000, maxBatchRecords: 1 })
    const gate = Promise.withResolvers<boolean>()
    provider.appendGate = gate.promise
    const first = await attached(ctx, 'session-a', 'conversation-a')
    const second = await attached(ctx, 'session-b', 'conversation-b')
    first.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'a1' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    first.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'a2' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    second.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'b1' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await vi.waitFor(() => { expect(provider.starts).toEqual(['conversation-a', 'conversation-b']) })
    gate.resolve(true)
    await Promise.all([ctx.sessions.flush(first), ctx.sessions.flush(second)])
    expect(provider.starts).toEqual(['conversation-a', 'conversation-b', 'conversation-a'])
  })

  it('retains the first Provider failure as the Session failure', async () => {
    const { ctx, provider } = await fixture({ maxDelayMs: 10_000 })
    const session = await attached(ctx)
    const failure = new Error('provider unavailable')
    provider.appendFailure = failure
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await expect(ctx.sessions.flush(session)).rejects.toBe(failure)
    provider.appendFailure = undefined
    await expect(ctx.sessions.flush(session)).rejects.toBe(failure)
  })
})
