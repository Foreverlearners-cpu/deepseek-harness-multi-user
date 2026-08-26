/** Web and in-process Agent lifecycle composition for semantic conversations. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Conversation } from '@deepseek-ai/dsh-conversation'
import type {} from '@deepseek-ai/dsh-conversation-persistence'
import { stableSessionIdentity } from '@deepseek-ai/dsh-conversation-starter'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional lifecycle adapter installed by dsh-conversation-web. */
    conversationWeb: ConversationWeb
  }
}

/** Conversation attachment adapter consumed opportunistically by Agent entry points. */
export class ConversationWeb extends Service {
  static inject = ['conversationStarter']

  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'conversationWeb')
  }

  /**
   * Attach one unpublished Agent before publication.
   * Ordinary Web forks are independent top-level conversations with the same
   * deployment owner labels; subagent lineage remains delegated lineage.
   * @param agentCtx - exact unpublished Agent setup context.
   * @returns attached conversation metadata.
   */
  async attach(agentCtx: Context): Promise<Conversation> {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('conversation-web: Agent setup context is required')
    const session = agent.session
    const header = session.header
    if (header.parentSession !== undefined && header.origin !== 'subagent') {
      return this.ctx.conversationPersistence.attach(session, {
        tenantId: this.ctx.conversationStarter.tenantId,
        userId: this.ctx.conversationStarter.localUserId,
        ...stableSessionIdentity(session.id),
        origin: 'top-level',
        delegationDepth: 0,
        retention: { kind: 'permanent' },
      })
    }
    return this.ctx.conversationStarter.attach(agentCtx)
  }

  /**
   * Run an existing setup first, then await attachment before publication.
   * @param existing - optional setup whose publication commit is preserved.
   * @returns the composed Agent setup.
   */
  compose(existing?: AgentSetup): AgentSetup {
    return async (agentCtx) => {
      const commit = await existing?.(agentCtx)
      await this.attach(agentCtx)
      return commit
    }
  }
}

export default ConversationWeb
