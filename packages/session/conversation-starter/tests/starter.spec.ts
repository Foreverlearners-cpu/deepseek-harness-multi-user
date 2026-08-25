import { Context } from '@deepseek-ai/cordis'
import type { AgentSetupCommit } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ConversationPersistence from '../../conversation-persistence/src/index.ts'
import ConversationStarter, { stableSessionIdentity } from '../src/index.ts'
import { MemoryConversationService } from './memory-provider.ts'

const contexts: Context[] = []

async function fixture(config: ConstructorParameters<typeof ConversationStarter>[1] = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryConversationService)
  await ctx.plugin(ConversationPersistence, { maxDelayMs: 10_000 })
  await ctx.plugin(ConversationStarter, config)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, provider: ctx.conversations as MemoryConversationService }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('local ownership setup', () => {
  it('defaults fixed local labels and hashes provider-safe Session ids deterministically', async () => {
    const { ctx } = await fixture()
    expect(ctx.conversationStarter.tenantId).toBe('local-tenant')
    expect(ctx.conversationStarter.localUserId).toBe('local-user')
    const first = stableSessionIdentity(SessionId('provider-safe-id'))
    expect(first).toEqual(stableSessionIdentity(SessionId('provider-safe-id')))
    expect(first.conversationId).toMatch(/^session-[0-9a-f]{64}$/)
    expect(first.sessionId).toBe('provider-safe-id')
    expect(() => stableSessionIdentity(SessionId('id with spaces'))).toThrow('session id must match')
  })

  it('attaches a root before publication and preserves the existing setup commit', async () => {
    const { ctx, provider } = await fixture({ tenantId: 'deployment', localUserId: 'operator' })
    const id = SessionId('root')
    const stable = stableSessionIdentity(id)
    const published: string[] = []
    ctx.on('session/created', () => {
      expect(provider.bySession.get(stable.sessionId)).toBeDefined()
      published.push('created')
    })
    const commitMock = vi.fn()
    const commit: AgentSetupCommit = { commit: commitMock }
    const handle = await ctx.agents.create({
      sessionId: id,
      setup: ctx.conversationStarter.compose((agentCtx) => {
        agentCtx.agent!.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'before attachment' }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        return commit
      }),
    })
    await ctx.sessions.flush(handle.agent.session)
    expect(commitMock).toHaveBeenCalledOnce()
    expect(published).toEqual(['created'])
    expect(provider.bySession.get(stable.sessionId)).toMatchObject({
      tenantId: 'deployment', userId: 'operator', origin: 'top-level', delegationDepth: 0,
      retention: { kind: 'permanent' },
    })
    expect(provider.recordsByConversation.get(stable.conversationId)?.map(record => record.type))
      .toEqual(['user/message'])
  })

  it('attaches a child through its parent and inherits ownership', async () => {
    const { ctx, provider } = await fixture()
    const parentId = SessionId('parent')
    const childId = SessionId('child')
    await ctx.agents.create({ sessionId: parentId, setup: ctx.conversationStarter.compose() })
    await ctx.agents.create({
      sessionId: childId,
      meta: { parentSession: parentId, origin: 'subagent', delegationDepth: 1 },
      setup: ctx.conversationStarter.compose(),
    })
    const parent = provider.bySession.get(stableSessionIdentity(parentId).sessionId)
    const child = provider.bySession.get(stableSessionIdentity(childId).sessionId)
    expect(child).toMatchObject({
      tenantId: parent?.tenantId,
      userId: parent?.userId,
      parentConversationId: parent?.conversationId,
      origin: 'subagent',
      delegationDepth: 1,
    })
  })

  it.each([
    ['subagent without parent', { origin: 'subagent' as const, delegationDepth: 1 }, /requires parentSession/u],
    ['subagent without depth', { origin: 'subagent' as const, parentSession: SessionId('parent') }, /positive delegationDepth/u],
    ['subagent at depth zero', { origin: 'subagent' as const, parentSession: SessionId('parent'), delegationDepth: 0 }, /positive delegationDepth/u],
    ['ordinary fork', { parentSession: SessionId('parent') }, /without origin="subagent"/u],
    ['root at child depth', { delegationDepth: 1 }, /root Session cannot/u],
  ])('rejects malformed lineage: %s', async (_name, meta, pattern) => {
    const { ctx } = await fixture()
    const id = SessionId(`malformed-${_name}`)
    await expect(ctx.agents.create({ sessionId: id, meta, setup: ctx.conversationStarter.compose() }))
      .rejects.toThrow(pattern)
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(ctx.agents.get(id)).toBeUndefined()
  })

  it('rejects a child whose parent has not been attached before publication', async () => {
    const { ctx } = await fixture()
    const childId = SessionId('orphan')
    await expect(ctx.agents.create({
      sessionId: childId,
      meta: { parentSession: SessionId('missing'), origin: 'subagent', delegationDepth: 1 },
      setup: ctx.conversationStarter.compose(),
    })).rejects.toThrow('parent Session is not attached')
    expect(ctx.sessions.get(childId)).toBeUndefined()
  })

  it('does not attach when an earlier setup rejects', async () => {
    const { ctx, provider } = await fixture()
    const id = SessionId('setup-rejects')
    await expect(ctx.agents.create({
      sessionId: id,
      setup: ctx.conversationStarter.compose(() => Promise.reject(new Error('setup failed'))),
    })).rejects.toThrow('setup failed')
    expect(provider.bySession.has(stableSessionIdentity(id).sessionId)).toBe(false)
  })
})
