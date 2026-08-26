import { Context } from '@deepseek-ai/cordis'
import type { AgentSetupCommit } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConversationPersistence from '../../conversation-persistence/src/index.ts'
import ConversationStarter, { stableSessionIdentity } from '../../conversation-starter/src/index.ts'
import { MemoryConversationService } from '../../conversation-starter/tests/memory-provider.ts'
import ConversationWeb from '../src/index.ts'

const contexts: Context[] = []

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryConversationService)
  await ctx.plugin(ConversationPersistence, { maxDelayMs: 10_000 })
  await ctx.plugin(ConversationStarter, { tenantId: 'web-tenant', localUserId: 'web-user' })
  await ctx.plugin(ConversationWeb)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, provider: ctx.conversations as MemoryConversationService }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('conversation Web lifecycle adapter', () => {
  it('rejects a context without an unpublished Agent', async () => {
    const { ctx } = await fixture()
    await expect(ctx.conversationWeb.attach(ctx.extend({}))).rejects.toThrow('Agent setup context is required')
  })

  it('attaches a root after existing setup and before publication', async () => {
    const { ctx, provider } = await fixture()
    const id = SessionId('web-root')
    const committed = vi.fn()
    const commit: AgentSetupCommit = { commit: committed }
    const published = vi.fn(() => {
      expect(provider.bySession.has(stableSessionIdentity(id).sessionId)).toBe(true)
    })
    ctx.on('session/created', published)

    const handle = await ctx.agents.create({
      sessionId: id,
      setup: ctx.conversationWeb.compose((agentCtx) => {
        agentCtx.agent!.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'persist me' }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        return commit
      }),
    })
    await ctx.conversationPersistence.flush(handle.agent.session)

    expect(committed).toHaveBeenCalledOnce()
    expect(published).toHaveBeenCalledOnce()
    expect(provider.bySession.get(stableSessionIdentity(id).sessionId)).toMatchObject({
      tenantId: 'web-tenant', userId: 'web-user', origin: 'top-level', delegationDepth: 0,
    })
    expect(provider.recordsByConversation.get(stableSessionIdentity(id).conversationId)?.map(record => record.type))
      .toEqual(['user/message'])
  })

  it('keeps infrastructure events Session-only while persisting titles and messages', async () => {
    const { ctx, provider } = await fixture()
    const id = SessionId('web-control-events')
    const handle = await ctx.agents.create({
      sessionId: id,
      setup: ctx.conversationWeb.compose((agentCtx) => {
        const session = agentCtx.agent!.session
        const message = createUserMessage({
          content: [{ type: 'text', text: 'persist only this record' }],
          source: { kind: 'user' },
        })
        session.append('permission/preset', { preset: 'workspace-write' })
        session.append('sandbox/mode', { mode: 'workspace-write' })
        session.append('approval/policy', { policy: 'ask' })
        session.append('agent-preset/selected', { agentPreset: 'standard' })
        session.append('session/title', {
          title: 'Stored only in Session', messageSeqs: [], source: { kind: 'user' },
        })
        session.append('agent/inbox/spliced', {
          target: 'next-turn', start: 0, inserted: [message],
        })
        session.append('agent/inbox/spliced', {
          target: 'next-turn', start: 0, removedCount: 1, inserted: [],
        })
        session.append('user/message', message, { surfaceOp: 'append' })
      }),
    })
    await ctx.conversationPersistence.flush(handle.agent.session)

    expect(handle.agent.session.events.map(event => event.type)).toEqual([
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
      'agent-preset/selected',
      'session/title',
      'agent/inbox/spliced',
      'agent/inbox/spliced',
      'user/message',
    ])
    expect(provider.recordsByConversation.get(stableSessionIdentity(id).conversationId)?.map(record => record.type))
      .toEqual(['conversation/title', 'user/message'])
    expect(provider.bySession.get(stableSessionIdentity(id).sessionId)?.title).toBe('Stored only in Session')
  })

  it('stores an ordinary Web fork as an independent top-level conversation', async () => {
    const { ctx, provider } = await fixture()
    const parentId = SessionId('web-parent')
    const childId = SessionId('web-fork')
    await ctx.agents.create({ sessionId: parentId, setup: ctx.conversationWeb.compose() })
    await ctx.agents.create({
      sessionId: childId,
      meta: { parentSession: parentId, seedLength: 0 },
      setup: ctx.conversationWeb.compose(),
    })

    expect(provider.bySession.get(stableSessionIdentity(childId).sessionId)).toMatchObject({
      tenantId: 'web-tenant',
      userId: 'web-user',
      origin: 'top-level',
      delegationDepth: 0,
    })
    expect(provider.bySession.get(stableSessionIdentity(childId).sessionId)?.parentConversationId).toBeUndefined()
  })

  it('keeps subagent parent ownership and delegation lineage', async () => {
    const { ctx, provider } = await fixture()
    const parentId = SessionId('web-owner')
    const childId = SessionId('web-subagent')
    await ctx.agents.create({ sessionId: parentId, setup: ctx.conversationWeb.compose() })
    await ctx.agents.create({
      sessionId: childId,
      meta: { parentSession: parentId, origin: 'subagent', delegationDepth: 1 },
      setup: ctx.conversationWeb.compose(),
    })

    const parent = provider.bySession.get(stableSessionIdentity(parentId).sessionId)
    expect(provider.bySession.get(stableSessionIdentity(childId).sessionId)).toMatchObject({
      tenantId: parent?.tenantId,
      userId: parent?.userId,
      parentConversationId: parent?.conversationId,
      origin: 'subagent',
      delegationDepth: 1,
    })
  })

  it('does not reserve a conversation when the existing setup rejects', async () => {
    const { ctx, provider } = await fixture()
    const id = SessionId('web-setup-rejects')
    await expect(ctx.agents.create({
      sessionId: id,
      setup: ctx.conversationWeb.compose(() => Promise.reject(new Error('setup failed'))),
    })).rejects.toThrow('setup failed')
    expect(provider.bySession.has(stableSessionIdentity(id).sessionId)).toBe(false)
  })
})
