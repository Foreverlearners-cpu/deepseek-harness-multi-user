/** SessionPersistence compatibility adapter backed by semantic MySQL rows. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionPreparation, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistence, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionInspection, SessionLocation, SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { MysqlConversationPersistence } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    conversationPersistence: MysqlConversationPersistence
  }
}

/** Compatibility adapter configuration. */
export interface Config {
  /** Kept for a stable plugin configuration surface; ownership is trusted from the delegate. */
  enabled?: boolean
}

/**
 * Lets the existing AgentLoop/SessionCheckpoint machinery consume the
 * message-only store. `append()` is a durability barrier: the conversation
 * projector already observes the live events, and this adapter waits for its
 * turn commit instead of writing a second event log.
 */
export class MysqlConversationSessionPersistence extends SessionPersistence {
  static inject = ['sessions', 'conversationPersistence']
  static Config: z<Config> = z.object({ enabled: z.boolean().default(true) })
  override readonly name = 'sessionPersistence'
  override readonly supportsRawArtifacts = false
  private readonly ready: Promise<void>

  constructor(ctx: Context, public config: Config = {}) {
    super(ctx)
    this.ready = Promise.resolve()
  }

  async [Service.init](): Promise<void> {
    await this.ready
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  async create(meta: SessionHeader): Promise<void> {
    await this.ready
    const existing = await this.ctx.conversationPersistence.getConversation(String(meta.id))
    if (existing !== undefined) return
    await this.ctx.conversationPersistence.createConversation({
      sessionId: String(meta.id), version: meta.version, cwd: meta.cwd ?? null,
      parentSessionId: meta.parentSession === undefined ? null : String(meta.parentSession),
      seedLength: meta.seedLength ?? null, origin: meta.origin ?? null,
      delegationDepth: meta.delegationDepth ?? null, agentPreset: meta.agentPreset ?? null,
      createdAt: meta.createdAt,
    })
  }

  async append(id: SessionId, _events: readonly SessionEvent[]): Promise<void> {
    await this.ready
    await this.ctx.conversationPersistence.flushSession(String(id))
  }

  override async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    signal?.throwIfAborted()
    const loaded = await this.load(id)
    signal?.throwIfAborted()
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('cannot prepare a conversation without SessionStore')
    return SessionPreparation.create(sessions.prepare(id, {
      seed: loaded.events.map(event => structuredClone(event)),
      meta: structuredClone(loaded.meta),
      seedSource: 'persistence',
    }))
  }

  async load(id: SessionId): Promise<SessionInspection> {
    const loaded = await this.ctx.conversationPersistence.hydrate(String(id))
    if (loaded === undefined) throw new Error(`session "${id}" not found`)
    return loaded
  }

  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    signal?.throwIfAborted()
    const loaded = await this.load(id)
    signal?.throwIfAborted()
    return loaded
  }

  async readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    signal?.throwIfAborted()
    const loaded = await this.load(id)
    signal?.throwIfAborted()
    return { meta: loaded.meta, events: loaded.events.filter(event => event.seq >= fromSeq) }
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const conversations = await this.ctx.conversationPersistence.listConversations({ limit: 500 })
    signal?.throwIfAborted()
    return conversations.map(conversation => ({
      version: 0,
      id: SessionId(conversation.sessionId),
      userId: this.ctx.conversationPersistence.userId,
      createdAt: conversation.createdAt,
      ...conversation.cwd === null ? {} : { cwd: conversation.cwd },
      ...conversation.parentSessionId === null ? {} : { parentSession: SessionId(conversation.parentSessionId) },
      ...conversation.origin === null ? {} : { origin: conversation.origin as 'subagent' },
      ...conversation.agentPreset === null ? {} : { agentPreset: conversation.agentPreset },
    }))
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const conversations = await this.ctx.conversationPersistence.listConversations({ limit: 500 })
    signal?.throwIfAborted()
    return conversations.map(conversation => ({
      header: {
        version: 0,
        id: SessionId(conversation.sessionId),
        userId: this.ctx.conversationPersistence.userId,
        createdAt: conversation.createdAt,
        ...conversation.cwd === null ? {} : { cwd: conversation.cwd },
        ...conversation.parentSessionId === null ? {} : { parentSession: SessionId(conversation.parentSessionId) },
        ...conversation.origin === null ? {} : { origin: conversation.origin as 'subagent' },
        ...conversation.agentPreset === null ? {} : { agentPreset: conversation.agentPreset },
      },
      revision: SessionPersistenceRevision(`conversation-mysql:${conversation.sessionId}:${conversation.revision}`),
    }))
  }
}

export default MysqlConversationSessionPersistence
