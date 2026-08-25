/** Explicit local ownership attachment for semantic conversation persistence. */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import {
  conversationId,
  conversationSessionId,
  conversationTenantId,
  conversationUserId,
  type Conversation,
  type ConversationId,
  type ConversationSessionId,
  type ConversationTenantId,
  type ConversationUserId,
} from '@deepseek-ai/dsh-conversation'
import type {} from '@deepseek-ai/dsh-conversation-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

/** Fixed local ownership labels applied to root Sessions. */
export interface Config {
  /** Local data-owner label; this is not a verified tenant identity. */
  readonly tenantId?: string
  /** Local data-owner label; this is not an authenticated user identity. */
  readonly localUserId?: string
}

/** Loader configuration with explicit single-user defaults. */
export const Config: z<Config> = z.object({
  tenantId: z.string().default('local-tenant'),
  localUserId: z.string().default('local-user'),
})

/** Conversation-safe deterministic identities derived from one runtime Session id. */
export interface StableSessionIdentity {
  readonly conversationId: ConversationId
  readonly sessionId: ConversationSessionId
}

/**
 * Map any Session id to fixed-length conversation-safe identifiers.
 * @param id - arbitrary runtime Session id.
 * @returns deterministic conversation and attachment identities.
 */
export function stableSessionIdentity(id: SessionId): StableSessionIdentity {
  const value = String(id)
  const digest = createHash('sha256').update(value, 'utf8').digest('hex')
  return {
    conversationId: conversationId(`session-${digest}`),
    sessionId: conversationSessionId(value),
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    conversationStarter: ConversationStarter
  }
}

/** Explicit Agent-creation adapter for local semantic conversation ownership. */
export class ConversationStarter extends Service {
  static inject = ['conversationPersistence']
  static Config = Config

  readonly tenantId: ConversationTenantId
  readonly localUserId: ConversationUserId

  /** @param ctx - owning Host context. @param config - fixed local owner labels. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'conversationStarter')
    const resolved = config as Required<Config>
    this.tenantId = conversationTenantId(resolved.tenantId)
    this.localUserId = conversationUserId(resolved.localUserId)
  }

  /**
   * Attach the unpublished Agent's Session before registry publication.
   * @param agentCtx - exact unpublished Agent setup context.
   * @returns attached conversation metadata.
   */
  async attach(agentCtx: Context): Promise<Conversation> {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('conversation-starter: Agent setup context is required')
    const session = agent.session
    const header = session.header

    if (header.origin === 'subagent') {
      if (header.parentSession === undefined) {
        throw new Error('conversation-starter: subagent Session requires parentSession')
      }
      if (header.delegationDepth === undefined || header.delegationDepth < 1) {
        throw new Error('conversation-starter: subagent Session requires positive delegationDepth')
      }
      const identity = stableSessionIdentity(session.id)
      return this.ctx.conversationPersistence.attach(session, {
        ...identity,
        parentSessionId: stableSessionIdentity(header.parentSession).sessionId,
        origin: 'subagent',
        delegationDepth: header.delegationDepth,
        retention: { kind: 'permanent' },
      })
    }

    if (header.parentSession !== undefined) {
      throw new Error('conversation-starter: parentSession without origin="subagent" is unsupported')
    }
    if (header.delegationDepth !== undefined && header.delegationDepth !== 0) {
      throw new Error('conversation-starter: root Session cannot have positive delegationDepth')
    }
    const identity = stableSessionIdentity(session.id)
    return this.ctx.conversationPersistence.attach(session, {
      tenantId: this.tenantId,
      userId: this.localUserId,
      ...identity,
      origin: 'top-level',
      delegationDepth: 0,
      retention: { kind: 'permanent' },
    })
  }

  /**
   * Compose conversation attachment after an existing unpublished setup.
   * @param existing - optional setup whose publication commit is preserved.
   * @returns setup that awaits attachment before publication.
   */
  compose(existing?: AgentSetup): AgentSetup {
    return async (agentCtx) => {
      const commit = await existing?.(agentCtx)
      await this.attach(agentCtx)
      return commit
    }
  }
}

export default ConversationStarter
