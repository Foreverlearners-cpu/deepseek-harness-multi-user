/** Project complete Session events into provider-neutral conversation records. */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  agentRecordId,
  conversationApprovalId,
  conversationMessageId,
  conversationStepId,
  conversationToolCallId,
  conversationTurnId,
} from '@deepseek-ai/dsh-conversation'
import type {
  AgentRecord,
  Conversation,
  ConversationAttachment,
  ConversationJsonValue,
} from '@deepseek-ai/dsh-conversation'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

/** Default fixed batching window after the first pending semantic record. */
export const DEFAULT_MAX_DELAY_MS = 500
/** Default record-count trigger for one Provider append. */
export const DEFAULT_MAX_BATCH_RECORDS = 64
/** Default encoded-size trigger for one Provider append. */
export const DEFAULT_MAX_BATCH_BYTES = 512 * 1024
/** Default per-Session admission bound, including records currently writing. */
export const DEFAULT_MAX_PENDING_RECORDS = 4096

const SESSION_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/policy',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'llm/retry',
  'llm/retry-started',
  'permission/preset',
  'plan/mode',
  'sandbox/mode',
  'schedule/change',
  'session/title-llm-request',
  'subagent/descriptor',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
  'web/deepseek-search-llm-request',
])

/** Tool effect persisted before execution. */
export type ToolEffect = 'read-only' | 'external-side-effect'

/** Input presented to a tool-effect classifier. */
export interface ToolEffectRequest {
  readonly session: Session
  readonly sourceSequence: number
  readonly toolName: string
  readonly arguments: ConversationJsonValue
}

/** Ordered classifier contribution; `undefined` delegates to the next classifier. */
export type ToolEffectClassifier = (request: ToolEffectRequest) => ToolEffect | undefined

/** Write-behind limits and static tool policy. */
export interface Config {
  readonly maxDelayMs?: number
  readonly maxBatchRecords?: number
  readonly maxBatchBytes?: number
  readonly maxPendingRecords?: number
  readonly toolEffects?: Readonly<Record<string, ToolEffect>>
}

export const Config: z<Config> = z.object({
  maxDelayMs: z.natural().default(DEFAULT_MAX_DELAY_MS),
  maxBatchRecords: z.natural().min(1).default(DEFAULT_MAX_BATCH_RECORDS),
  maxBatchBytes: z.natural().min(1).default(DEFAULT_MAX_BATCH_BYTES),
  maxPendingRecords: z.natural().min(1).default(DEFAULT_MAX_PENDING_RECORDS),
  toolEffects: z.dict(z.union(['read-only', 'external-side-effect'] as const)).default({}),
})

/** Complete semantic record before conversation identity and business sequence allocation. */
export type ConversationRecordDraft = AgentRecord extends infer T
  ? T extends AgentRecord
    ? Omit<T, 'tenantId' | 'userId' | 'conversationId' | 'sequence'>
    : never
  : never

interface PendingDraft {
  readonly draft: ConversationRecordDraft
}

/** Input offered to extension-event projectors in registration order. */
export interface ConversationEventProjectionRequest {
  readonly session: Session
  readonly event: SessionEvent
  readonly base: (suffix?: string) => Pick<ConversationRecordDraft, 'recordId' | 'sourceSequence' | 'occurredAt' | 'extensions'>
}

/** Explicit mapper for one plugin-owned Session event; `undefined` delegates. */
export type ConversationEventProjector = (
  request: ConversationEventProjectionRequest,
) => readonly ConversationRecordDraft[] | undefined

/** Input passed through ordered asynchronous record preparers before append. */
export interface ConversationRecordPrepareRequest {
  readonly session: Session
  readonly conversation: Conversation
  readonly draft: ConversationRecordDraft
}

/**
 * Prepare one record before Provider append. Returning `undefined` preserves
 * the input; returning a draft replaces it for subsequent preparers.
 */
export type ConversationRecordPreparer = (
  request: ConversationRecordPrepareRequest,
) => Promise<ConversationRecordDraft | undefined> | ConversationRecordDraft | undefined

interface SessionState {
  readonly session: Session
  readonly admittedSources: Set<number>
  readonly persistedSources: Set<number>
  readonly pending: PendingDraft[]
  conversation?: Conversation
  attaching?: Promise<Conversation>
  timer: ReturnType<typeof setTimeout> | undefined
  timerExpired: boolean
  writing: Promise<void>
  activeCount: number
  stickyError?: Error
  retired: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    conversationPersistence: ConversationPersistence
  }
}

/**
 * Session-to-conversation Consumer with bounded, per-Session write-behind.
 * Call {@link attach} before the Session's first semantic event.
 */
export class ConversationPersistence extends Service {
  static inject = ['conversations', 'sessions']
  static Config: z<Config> = Config

  private readonly states = new Map<Session, SessionState>()
  private readonly classifiers: ToolEffectClassifier[] = []
  private readonly projectors: ConversationEventProjector[] = []
  private readonly preparers: ConversationRecordPreparer[] = []
  private readonly retirements = new Set<Promise<void>>()

  /** @param ctx - owning Host context. @param config - bounded batching policy. */
  constructor(ctx: Context, public config: Config) {
    super(ctx, 'conversationPersistence')

    ctx.on('session/created', (session) => { this.initialize(session) })
    ctx.on('session/event', (session, event) => { this.admit(session, event) })
    ctx.on('session/flush', session => this.flush(session))
    ctx.on('session/disposed', (session) => { this.retire(session) })

    for (const session of ctx.sessions.list()) this.initialize(session)
    ctx.effect(() => async () => {
      for (const state of this.states.values()) this.cancelTimer(state)
      await Promise.allSettled([
        ...[...this.states.values()].map(state => this.flushState(state)),
        ...this.retirements,
      ])
      this.states.clear()
    }, 'conversationPersistence.drain')
  }

  /**
   * Register one ordered tool-effect classifier. The first classifier that
   * returns an effect owns the decision; disposal removes the contribution.
   * @param classifier - policy contribution.
   * @returns idempotent disposer.
   */
  registerToolEffectClassifier(classifier: ToolEffectClassifier): () => void {
    this.classifiers.push(classifier)
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = this.classifiers.indexOf(classifier)
      if (index >= 0) this.classifiers.splice(index, 1)
    }
  }

  /**
   * Register an ordered mapper for plugin-owned Session events. A projector
   * returns `undefined` only when it does not own the event.
   * @param projector - extension-event mapper.
   * @returns idempotent disposer.
   */
  registerEventProjector(projector: ConversationEventProjector): () => void {
    this.projectors.push(projector)
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = this.projectors.indexOf(projector)
      if (index >= 0) this.projectors.splice(index, 1)
    }
  }

  /**
   * Register an ordered asynchronous transformation before Provider append.
   * Preparers may externalize complete payloads but must preserve record source
   * identity and type.
   * @param preparer - ordered record transformation.
   * @returns idempotent disposer.
   */
  registerRecordPreparer(preparer: ConversationRecordPreparer): () => void {
    this.preparers.push(preparer)
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = this.preparers.indexOf(preparer)
      if (index >= 0) this.preparers.splice(index, 1)
    }
  }

  /**
   * Bind a live Session to explicit conversation ownership, discover already
   * projected source sequences, then admit its constructor seed.
   * @param session - exact live Session.
   * @param attachment - root ownership or child-parent binding.
   * @returns attached conversation after queued seed admission is ready.
   */
  async attach(session: Session, attachment: ConversationAttachment): Promise<Conversation> {
    const state = this.stateFor(session)
    if (state.attaching !== undefined) return state.attaching
    const attaching = this.attachCore(state, attachment)
    state.attaching = attaching
    try {
      return await attaching
    } catch (error) {
      throw this.fail(state, error)
    }
  }

  /** Flush one Session immediately and surface its first sticky failure. */
  async flush(session: Session): Promise<void> {
    await this.flushState(this.stateFor(session))
  }

  private initialize(session: Session): SessionState {
    const existing = this.states.get(session)
    if (existing !== undefined) return existing
    const state: SessionState = {
      session,
      admittedSources: new Set(),
      persistedSources: new Set(),
      pending: [],
      writing: Promise.resolve(),
      activeCount: 0,
      timer: undefined,
      timerExpired: false,
      retired: false,
    }
    this.states.set(session, state)
    for (const event of session.events) this.admitInto(state, event)
    return state
  }

  private stateFor(session: Session): SessionState {
    return this.states.get(session) ?? this.initialize(session)
  }

  private admit(session: Session, event: SessionEvent): void {
    this.admitInto(this.stateFor(session), event)
  }

  private admitInto(state: SessionState, event: SessionEvent): void {
    if (state.retired || state.stickyError !== undefined || state.admittedSources.has(event.seq)) return
    let drafts: readonly ConversationRecordDraft[]
    try {
      drafts = this.project(state.session, event)
    } catch (error) {
      this.fail(state, error)
      return
    }
    state.admittedSources.add(event.seq)
    if (drafts.length === 0) return
    if (state.pending.length + state.activeCount + drafts.length > this.maxPendingRecords) {
      this.fail(state, new Error(`conversation persistence: session "${state.session.id}" exceeded maxPendingRecords=${this.maxPendingRecords}`))
      return
    }
    for (const draft of drafts) {
      state.pending.push({ draft })
    }
    if (state.conversation === undefined) return
    if (this.batchReady(state)) this.scheduleWrite(state, true)
    else this.armTimer(state)
  }

  private async attachCore(state: SessionState, attachment: ConversationAttachment): Promise<Conversation> {
    if (String(attachment.sessionId) !== String(state.session.id)) {
      throw new Error(`conversation persistence: attachment sessionId "${attachment.sessionId}" does not match Session "${state.session.id}"`)
    }
    const conversation = await this.ctx.conversations.attach(attachment)
    let cursor: Awaited<ReturnType<typeof this.ctx.conversations.records>>['nextCursor']
    do {
      const page = await this.ctx.conversations.records({
        tenantId: conversation.tenantId,
        userId: conversation.userId,
        conversationId: conversation.conversationId,
        limit: 1000,
        ...cursor === undefined ? {} : { cursor },
      })
      for (const record of page.records) state.persistedSources.add(record.sourceSequence)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    state.conversation = conversation
    for (let index = state.pending.length - 1; index >= 0; index -= 1) {
      const pending = state.pending[index]
      if (pending !== undefined && state.persistedSources.has(pending.draft.sourceSequence)) state.pending.splice(index, 1)
    }
    if (state.pending.length > 0) {
      if (this.batchReady(state)) this.scheduleWrite(state, true)
      else this.armTimer(state)
    }
    return conversation
  }

  private project(session: Session, event: SessionEvent): readonly ConversationRecordDraft[] {
    const base = (suffix = '') => ({
      recordId: agentRecordId(`${session.id}~${event.seq}${suffix}`),
      sourceSequence: event.seq,
      occurredAt: event.time,
      extensions: {},
    })
    switch (event.type) {
      case 'user/message':
        return [{
          ...base(),
          type: 'user/message',
          status: 'completed',
          payload: {
            messageId: conversationMessageId(String(event.data.id)),
            visibility: event.data.source.kind === 'user' ? 'user' : 'internal',
            text: visibleText(event.data.content),
          },
        }]
      case 'assistant/message':
        return [{
          ...base(),
          turnId: turnId(session, event.data.turn),
          stepId: stepId(session, event.data.turn, event.data.step),
          type: 'assistant/message',
          status: 'completed',
          payload: {
            messageId: conversationMessageId(String(event.data.message.id)),
            visibility: 'user',
            text: visibleText(event.data.message.content),
          },
        }]
      case 'tool/call': {
        const args = parseArguments(event.data.arguments)
        const effect = this.classifyEffect({
          session,
          sourceSequence: event.seq,
          toolName: event.data.name,
          arguments: args,
        })
        return [{
          ...base(),
          turnId: turnId(session, event.data.turn),
          stepId: stepId(session, event.data.turn, event.data.step),
          type: 'tool/call',
          status: 'completed',
          payload: {
            toolCallId: conversationToolCallId(String(event.data.callId)),
            toolName: event.data.name,
            arguments: args,
            effect,
          },
        }]
      }
      case 'tool/result':
        return [{
          ...base(),
          turnId: turnId(session, event.data.turn),
          stepId: stepId(session, event.data.turn, event.data.step),
          type: 'tool/result',
          status: 'completed',
          payload: {
            toolCallId: conversationToolCallId(String(event.data.message.source.callId)),
            outcome: event.data.message.content[0].isError === true || event.data.error !== undefined ? 'failed' : 'completed',
            result: structuredClone(event.data.message.content) as unknown as ConversationJsonValue,
          },
        }]
      case 'turn/end':
        return projectTurnEnd(session, event, base)
      case 'assistant/chunk':
      case 'turn/start':
      case 'step/start':
      case 'step/end':
      case 'todo/write':
      case 'request/header':
      case 'request/context':
      case 'session/end-seed':
        return []
      default:
        const extension = event as unknown as {
          readonly type: string
          readonly data: unknown
          readonly seq: number
          readonly ignorable?: boolean
        }
        if (extension.type === 'session/title') {
          const data = extension.data as { title: string }
          return [{ ...base(), type: 'conversation/title', status: 'completed', payload: { title: data.title } }]
        }
        if (extension.type === 'approval/asked') {
          const data = extension.data as { id: string; toolName: string; callId?: string; reason?: string }
          return [{
            ...base(),
            type: 'approval/asked',
            status: 'completed',
            payload: {
              approvalId: conversationApprovalId(data.id),
              ...(data.callId === undefined ? {} : { toolCallId: conversationToolCallId(data.callId) }),
              summary: data.reason ?? data.toolName,
            },
          }]
        }
        if (extension.type === 'approval/decided') {
          const data = extension.data as {
            id: string
            outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
          }
          let policy: string | undefined
          for (const candidate of session.events) {
            if (candidate.seq >= extension.seq) break
            const prior = candidate as unknown as { readonly type: string; readonly data: unknown }
            if (prior.type === 'approval/policy') policy = (prior.data as { readonly policy: string }).policy
          }
          const decidedBy = data.outcome === 'rejected'
            && policy === 'never'
            ? 'policy' as const
            : 'unknown' as const
          return [{
            ...base(),
            type: 'approval/decided',
            status: 'completed',
            payload: {
              approvalId: conversationApprovalId(data.id),
              decision: data.outcome === 'allowed-once' ? 'approved' : 'denied',
              decidedBy,
            },
          }]
        }
        if (SESSION_ONLY_EVENT_TYPES.has(extension.type)) return []
        for (const projector of this.projectors) {
          const records = projector({ session, event, base })
          if (records !== undefined) return records
        }
        if (extension.ignorable === true) return []
        throw new Error(`conversation persistence: required Session event "${extension.type}" has no registered projector`)
    }
  }

  private classifyEffect(request: ToolEffectRequest): ToolEffect {
    const configured = this.config.toolEffects?.[request.toolName]
    if (configured !== undefined) return configured
    for (const classifier of this.classifiers) {
      const effect = classifier(request)
      if (effect !== undefined) return effect
    }
    throw new Error(`conversation persistence: no tool-effect policy classified "${request.toolName}" at sourceSequence ${request.sourceSequence}`)
  }

  private armTimer(state: SessionState): void {
    if (state.timer !== undefined || state.pending.length === 0) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      state.timerExpired = true
      this.scheduleWrite(state, true)
    }, this.maxDelayMs)
  }

  private cancelTimer(state: SessionState): void {
    if (state.timer === undefined) return
    clearTimeout(state.timer)
    state.timer = undefined
  }

  private batchReady(state: SessionState): boolean {
    if (state.pending.length >= this.maxBatchRecords) return true
    const conversation = state.conversation
    if (conversation === undefined) return false
    let bytes = 0
    for (let index = 0; index < state.pending.length; index += 1) {
      const pending = state.pending[index]
      if (pending === undefined) break
      bytes += encodedRecordBytes(conversation, pending.draft, conversation.nextSequence + index)
      if (bytes >= this.maxBatchBytes) return true
    }
    return false
  }

  private scheduleWrite(state: SessionState, immediate: boolean): void {
    if (state.stickyError !== undefined
      || state.conversation === undefined
      || state.pending.length === 0
      || state.activeCount > 0) return
    if (immediate) {
      this.cancelTimer(state)
      state.timerExpired = false
    }
    const batch = takeBatch(
      state.pending,
      state.conversation,
      this.maxBatchRecords,
      this.maxBatchBytes,
    )
    state.activeCount += batch.length
    const run = async (): Promise<void> => {
      if (state.stickyError !== undefined) return
      const conversation = state.conversation
      if (conversation === undefined) return
      let drafts: readonly ConversationRecordDraft[]
      try {
        drafts = await this.prepareBatch(state.session, conversation, batch)
      } catch (error) {
        state.pending.unshift(...batch)
        this.fail(state, error)
        state.activeCount -= batch.length
        return
      }
      const records = drafts.map((draft, offset) => ({
        ...draft,
        tenantId: conversation.tenantId,
        userId: conversation.userId,
        conversationId: conversation.conversationId,
        sequence: conversation.nextSequence + offset,
      })) as AgentRecord[]
      try {
        const commit = await this.ctx.conversations.append({
          tenantId: conversation.tenantId,
          userId: conversation.userId,
          conversationId: conversation.conversationId,
          expectedNextSequence: conversation.nextSequence,
          records,
        })
        state.conversation = commit.conversation
        for (const record of commit.records) state.persistedSources.add(record.sourceSequence)
      } catch (error) {
        state.pending.unshift(...batch)
        this.fail(state, error)
      } finally {
        state.activeCount -= batch.length
      }
      if (this.failureOf(state) === undefined && state.pending.length > 0) {
        if (state.timerExpired || this.batchReady(state)) this.scheduleWrite(state, true)
        else this.armTimer(state)
      }
    }
    state.writing = state.writing.then(run, run)
  }

  private async prepareBatch(
    session: Session,
    conversation: Conversation,
    batch: readonly PendingDraft[],
  ): Promise<readonly ConversationRecordDraft[]> {
    const prepared: ConversationRecordDraft[] = []
    for (const pending of batch) {
      let draft = pending.draft
      for (const preparer of this.preparers) {
        const candidate = await preparer({ session, conversation, draft })
        if (candidate === undefined) continue
        if (candidate.recordId !== draft.recordId
          || candidate.sourceSequence !== draft.sourceSequence
          || candidate.type !== draft.type) {
          throw new Error('conversation persistence: record preparer changed source identity or type')
        }
        draft = candidate
      }
      prepared.push(draft)
    }
    return prepared
  }

  private async flushState(state: SessionState): Promise<void> {
    this.cancelTimer(state)
    this.assertHealthy(state)
    if (state.pending.length > 0 && state.conversation === undefined) {
      throw this.fail(state, new Error(`conversation persistence: session "${state.session.id}" has semantic records but is not attached`))
    }
    while (state.pending.length > 0) {
      this.scheduleWrite(state, true)
      await state.writing
      this.assertHealthy(state)
    }
    await state.writing
    this.assertHealthy(state)
  }

  private retire(session: Session): void {
    const state = this.states.get(session)
    if (state === undefined) return
    state.retired = true
    const retirement = this.flushState(state).finally(() => {
      this.states.delete(session)
      this.retirements.delete(retirement)
    })
    this.retirements.add(retirement)
    void retirement.catch((error: unknown) => {
      this.ctx.logger.warn(`conversation persistence: session "${session.id}" retirement failed: ${String(error)}`)
    })
  }

  private fail(state: SessionState, error: unknown): Error {
    state.stickyError ??= error instanceof Error ? error : new Error(String(error))
    this.cancelTimer(state)
    return state.stickyError
  }

  private failureOf(state: SessionState): Error | undefined {
    return state.stickyError
  }

  private assertHealthy(state: SessionState): void {
    const failure = this.failureOf(state)
    if (failure !== undefined) throw failure
  }

  private get maxDelayMs(): number { return this.config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS }
  private get maxBatchRecords(): number { return this.config.maxBatchRecords ?? DEFAULT_MAX_BATCH_RECORDS }
  private get maxBatchBytes(): number { return this.config.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES }
  private get maxPendingRecords(): number { return this.config.maxPendingRecords ?? DEFAULT_MAX_PENDING_RECORDS }
}

function visibleText(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function parseArguments(raw: string): ConversationJsonValue {
  try {
    return JSON.parse(raw) as ConversationJsonValue
  } catch {
    // Raw model arguments are still a complete value when the model emitted invalid JSON.
    return raw
  }
}

function turnId(session: Session, turn: number) {
  return conversationTurnId(`${session.id}~turn~${turn}`)
}

function stepId(session: Session, turn: number, step: number) {
  return conversationStepId(`${session.id}~turn~${turn}~step~${step}`)
}

function projectTurnEnd(
  session: Session,
  event: Extract<SessionEvent, { type: 'turn/end' }>,
  base: (suffix?: string) => Pick<ConversationRecordDraft, 'recordId' | 'sourceSequence' | 'occurredAt' | 'extensions'>,
): readonly ConversationRecordDraft[] {
  const id = turnId(session, event.data.turn)
  const reason = event.data.reason
  const completed = (outcome: 'completed' | 'failed' | 'interrupted'): ConversationRecordDraft => ({
    ...base(),
    turnId: id,
    type: 'turn/completed',
    status: 'completed',
    payload: { turnId: id, outcome },
  })
  switch (reason.kind) {
    case 'completed':
    case 'max-tokens':
      return [completed('completed')]
    case 'blocked':
      return [completed('failed')]
    case 'interrupted':
    case 'aborted': {
      if (!hasUnfinishedAssistantAttempt(session, event)) return [completed('interrupted')]
      return [{
        ...base('~interrupted'),
        turnId: id,
        type: 'assistant/interrupted',
        status: 'interrupted',
        payload: { attemptId: `${session.id}~turn~${event.data.turn}` },
      }, { ...completed('interrupted'), ...base('~turn') }]
    }
    case 'error':
      if (!hasUnfinishedAssistantAttempt(session, event)) return [completed('failed')]
      return [{
        ...base('~interrupted'),
        turnId: id,
        type: 'assistant/interrupted',
        status: 'interrupted',
        payload: { attemptId: `${session.id}~turn~${event.data.turn}`, errorCode: reason.error.code },
      }, { ...completed('failed'), ...base('~turn') }]
    default:
      throw new Error(`conversation persistence: required turn-end reason "${(reason as { kind: string }).kind}" is unsupported`)
  }
}

function hasUnfinishedAssistantAttempt(
  session: Session,
  end: Extract<SessionEvent, { type: 'turn/end' }>,
): boolean {
  let openStep: number | undefined
  for (const event of session.events) {
    if (event.seq >= end.seq) break
    if (event.type === 'step/start' && event.data.turn === end.data.turn) openStep = event.data.step
    if (openStep !== undefined
      && event.type === 'assistant/message'
      && event.data.turn === end.data.turn
      && event.data.step === openStep) openStep = undefined
  }
  return openStep !== undefined
}

function takeBatch(
  queue: PendingDraft[],
  conversation: Conversation,
  maxRecords: number,
  maxBytes: number,
): PendingDraft[] {
  let count = 0
  let bytes = 0
  while (count < queue.length) {
    const first = queue[count]
    if (first === undefined) break
    let groupEnd = count + 1
    while (queue[groupEnd]?.draft.sourceSequence === first.draft.sourceSequence) groupEnd += 1
    let groupBytes = 0
    for (let index = count; index < groupEnd; index += 1) {
      const item = queue[index]
      if (item !== undefined) {
        groupBytes += encodedRecordBytes(conversation, item.draft, conversation.nextSequence + index)
      }
    }
    if (count > 0 && (groupEnd > maxRecords || bytes + groupBytes > maxBytes)) break
    bytes += groupBytes
    count = groupEnd
    if (count >= maxRecords || bytes >= maxBytes) break
  }
  return queue.splice(0, count)
}

function encodedRecordBytes(
  conversation: Conversation,
  draft: ConversationRecordDraft,
  sequence: number,
): number {
  return Buffer.byteLength(JSON.stringify({
    ...draft,
    tenantId: conversation.tenantId,
    userId: conversation.userId,
    conversationId: conversation.conversationId,
    sequence,
  }), 'utf8')
}

export default ConversationPersistence
