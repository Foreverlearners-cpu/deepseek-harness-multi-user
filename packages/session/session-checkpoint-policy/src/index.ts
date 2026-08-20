/**
 * Semantic durability checkpoints for model requests, top-level tool dispatch,
 * completed agent steps, and configurable time-based write-behind.
 * @module @deepseek-ai/dsh-session-checkpoint-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED_BEFORE_DISPATCH, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'session-checkpoint-policy'

/** Services whose request, tool, session, and persistence boundaries this policy joins. */
export const inject = ['llm', 'sessionPersistence', 'sessions', 'tools']

/** The first shipped strategy. New strategies can be registered without changing the scheduler. */
export const DEFAULT_CHECKPOINT_STRATEGY = 'time'

/** Default delay for a dirty session before a background checkpoint. */
export const DEFAULT_INTERVAL_MS = 3_000

/** Reasons surfaced to checkpoint strategies and diagnostics. */
export type CheckpointReason =
  | 'time'
  | 'turn-end'
  | 'model-boundary'
  | 'tool-boundary'
  | 'step-boundary'
  | 'shutdown'
  | 'manual'

/** Input observed by a checkpoint strategy. */
export interface CheckpointInput {
  sessionId: string
  durableEventCount: number
  durableBytes: number
  elapsedMs: number
  lastEventType?: string
  reason: CheckpointReason
}

/** Backend-independent policy contract. */
export interface CheckpointPolicy {
  shouldCheckpoint(input: CheckpointInput): boolean
}

/** Resolved options supplied to policy factories. */
export interface ResolvedConfig {
  strategy: string
  intervalMs: number
  forceAtTurnEnd: boolean
  forceAtShutdown: boolean
}

/** Factory used by optional strategy packages to extend this plugin. */
export type CheckpointPolicyFactory = (config: Readonly<ResolvedConfig>) => CheckpointPolicy

/** Plugin configuration. Time is the default strategy; other strategies are extension points. */
export interface Config {
  /** Registered strategy name used for ordinary background checkpoints. */
  strategy?: string
  /** Milliseconds a dirty session may remain before the time strategy flushes it. */
  intervalMs?: number
  /** Flush at the end of each model turn. */
  forceAtTurnEnd?: boolean
  /** Flush dirty sessions while the plugin is shutting down. */
  forceAtShutdown?: boolean
}

/** Loader schema for the policy plugin. */
export const Config: z<Config> = z.object({
  strategy: z.string().default(DEFAULT_CHECKPOINT_STRATEGY),
  intervalMs: z.number().step(1).min(1).default(DEFAULT_INTERVAL_MS),
  forceAtTurnEnd: z.boolean().default(true),
  forceAtShutdown: z.boolean().default(true),
})

/** A simple elapsed-time policy used by the default plugin configuration. */
export class TimeCheckpointPolicy implements CheckpointPolicy {
  constructor(readonly intervalMs: number) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error(`time checkpoint intervalMs must be a positive safe integer, got ${String(intervalMs)}`)
    }
  }

  shouldCheckpoint(input: CheckpointInput): boolean {
    return input.elapsedMs >= this.intervalMs
  }
}

const policyFactories = new Map<string, CheckpointPolicyFactory>([
  [DEFAULT_CHECKPOINT_STRATEGY, config => new TimeCheckpointPolicy(config.intervalMs)],
])

/**
 * Register a policy factory for a strategy name.
 *
 * Registration is intentionally process-local: a deployment composes its
 * strategy package before loading this plugin. The returned disposer restores
 * the previous factory, which makes HMR and tests safe.
 * @param strategy Stable kebab-case strategy name.
 * @param factory Factory that constructs the strategy for resolved config.
 * @returns A disposer that unregisters this factory when still current.
 */
export function registerCheckpointPolicy(strategy: string, factory: CheckpointPolicyFactory): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(strategy)) throw new Error(`invalid checkpoint strategy name: ${strategy}`)
  const previous = policyFactories.get(strategy)
  policyFactories.set(strategy, factory)
  return () => {
    if (policyFactories.get(strategy) !== factory) return
    if (previous === undefined) policyFactories.delete(strategy)
    else policyFactories.set(strategy, previous)
  }
}

/** Construct the selected strategy, rejecting an unknown deployment choice.
 * @param config Resolved plugin configuration.
 * @returns The strategy selected by {@link ResolvedConfig.strategy}.
 */
export function createCheckpointPolicy(config: Readonly<ResolvedConfig>): CheckpointPolicy {
  const factory = policyFactories.get(config.strategy)
  if (factory === undefined) {
    throw new Error(`unknown session checkpoint strategy "${config.strategy}"; registered strategies: ${[...policyFactories.keys()].join(', ')}`)
  }
  return factory(config)
}

function resolveConfig(config: Config | undefined): ResolvedConfig {
  const resolved: ResolvedConfig = {
    strategy: config?.strategy ?? DEFAULT_CHECKPOINT_STRATEGY,
    intervalMs: config?.intervalMs ?? DEFAULT_INTERVAL_MS,
    forceAtTurnEnd: config?.forceAtTurnEnd ?? true,
    forceAtShutdown: config?.forceAtShutdown ?? true,
  }
  if (!Number.isSafeInteger(resolved.intervalMs) || resolved.intervalMs < 1) {
    throw new Error(`session checkpoint intervalMs must be a positive safe integer, got ${String(resolved.intervalMs)}`)
  }
  return resolved
}

/** Only events represented by the message-only conversation store count as durable work. */
function isDurableEvent(event: SessionEvent): boolean {
  const type = event.type as string
  return type === 'user/message'
    || type === 'assistant/message'
    || type === 'tool/result'
    || type === 'session/title'
}

/** Approximate UTF-8 payload size without making the strategy depend on a storage backend. */
function eventByteSize(event: SessionEvent): number {
  try {
    const encoded = JSON.stringify(event.data)
    return encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8')
  } catch {
    return 0
  }
}

interface SessionState {
  generation: number
  pendingCount: number
  pendingBytes: number
  dirtySince: number | undefined
  lastEventType: string | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  inFlight: Promise<void> | undefined
}

/**
 * Per-session scheduler shared by semantic barriers and the time strategy.
 * It never writes a backend itself; every write goes through sessions.flush.
 */
class CheckpointScheduler {
  private readonly states = new Map<Session, SessionState>()

  constructor(
    private readonly ctx: Context,
    private readonly policy: CheckpointPolicy,
    private readonly config: ResolvedConfig,
  ) {}

  observe(session: Session, event: SessionEvent): void {
    const type = event.type as string
    if (type === 'turn/end') {
      if (this.config.forceAtTurnEnd) {
        void this.flush(session, 'turn-end', true).catch(error => this.reportFailure(session, 'turn-end', error))
      }
      return
    }
    // Raw assistant/chunk events intentionally do not enter this path.
    if (!isDurableEvent(event)) return
    const state = this.stateFor(session)
    state.generation += 1
    state.pendingCount += 1
    state.pendingBytes += eventByteSize(event)
    state.dirtySince ??= Date.now()
    state.lastEventType = type
    this.armTimer(session, state)
    // The default time policy returns false here because elapsedMs is near
    // zero. Extension policies (for example event-count or manual-admission
    // adapters) may decide that this event already satisfies their trigger.
    const input: CheckpointInput = {
      sessionId: String(session.id),
      durableEventCount: state.pendingCount,
      durableBytes: state.pendingBytes,
      elapsedMs: Date.now() - (state.dirtySince ?? Date.now()),
      lastEventType: type,
      reason: 'time',
    }
    if (this.policy.shouldCheckpoint(input)) {
      void this.flush(session, 'time', false).catch(error => this.reportFailure(session, 'time', error))
    }
  }

  /** Await a mandatory semantic barrier and fold it into the scheduler state. */
  flushMandatory(session: Session, reason: Extract<CheckpointReason, 'model-boundary' | 'tool-boundary' | 'step-boundary'>): Promise<void> {
    return this.flush(session, reason, true)
  }

  /** Drain dirty sessions before this plugin's dependencies are disposed. */
  async dispose(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.timer !== undefined) clearTimeout(state.timer)
      state.timer = undefined
    }
    if (!this.config.forceAtShutdown) {
      this.states.clear()
      return
    }
    const dirty = [...this.states.entries()]
      .filter(([, state]) => state.pendingCount > 0)
      .map(([session]) => this.flush(session, 'shutdown', true))
    const results = await Promise.allSettled(dirty)
    for (const result of results) {
      if (result.status === 'rejected') this.ctx.logger.warn(`session checkpoint shutdown flush failed: ${String(result.reason)}`)
    }
    this.states.clear()
  }

  /** Session persistence owns the final retirement flush; discard timer state here. */
  forget(session: Session): void {
    const state = this.states.get(session)
    if (state?.timer !== undefined) clearTimeout(state.timer)
    this.states.delete(session)
  }

  private stateFor(session: Session): SessionState {
    const current = this.states.get(session)
    if (current !== undefined) return current
    const state: SessionState = {
      generation: 0,
      pendingCount: 0,
      pendingBytes: 0,
      dirtySince: undefined,
      lastEventType: undefined,
      timer: undefined,
      inFlight: undefined,
    }
    this.states.set(session, state)
    return state
  }

  private armTimer(session: Session, state: SessionState): void {
    if (state.timer !== undefined || state.pendingCount === 0) return
    const dirtySince = state.dirtySince ?? Date.now()
    const remaining = Math.max(1, this.config.intervalMs - (Date.now() - dirtySince))
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.flush(session, 'time', false).catch(error => this.reportFailure(session, 'time', error))
    }, remaining)
  }

  private flush(session: Session, reason: CheckpointReason, force: boolean): Promise<void> {
    const state = this.stateFor(session)
    if (state.inFlight !== undefined) return state.inFlight
    if (!force && state.pendingCount === 0) return Promise.resolve()

    const now = Date.now()
    const input: CheckpointInput = {
      sessionId: String(session.id),
      durableEventCount: state.pendingCount,
      durableBytes: state.pendingBytes,
      elapsedMs: state.dirtySince === undefined ? 0 : now - state.dirtySince,
      ...(state.lastEventType === undefined ? {} : { lastEventType: state.lastEventType }),
      reason,
    }
    if (!force && !this.policy.shouldCheckpoint(input)) {
      this.armTimer(session, state)
      return Promise.resolve()
    }

    const generation = state.generation
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
    let flushResult: Promise<boolean>
    try {
      // Call the SessionStore entry point synchronously so its listeners are
      // entered before the caller's first microtask (the semantic barrier's
      // ordering contract). Promise normalization only wraps its completion.
      flushResult = this.ctx.sessions.flush(session)
    } catch (error: unknown) {
      flushResult = Promise.reject(error)
    }
    const operation = Promise.resolve(flushResult)
      .then(() => {
        // Events appended while the flush was in flight remain dirty and get
        // their own timer; only the observed generation is marked clean.
        if (state.generation === generation) {
          state.pendingCount = 0
          state.pendingBytes = 0
          state.dirtySince = undefined
          state.lastEventType = undefined
        }
      })
      .finally(() => {
        if (state.inFlight === operation) state.inFlight = undefined
        if (state.pendingCount > 0) this.armTimer(session, state)
      })
    state.inFlight = operation
    return operation
  }

  private reportFailure(session: Session, reason: CheckpointReason, error: unknown): void {
    this.ctx.logger.warn(`session checkpoint ${reason} flush for "${session.id}" failed; pending messages retained: ${String(error)}`)
  }
}

/**
 * Delay construction of the downstream model stream until the complete logged
 * request prefix is durable. A checkpoint rejection prevents adapter dispatch.
 *
 * @param scheduler - scheduler that serializes this barrier with time flushes.
 * @param session - live session named by the model request.
 * @param next - downstream `llm/stream` chain.
 * @returns a stream that checkpoints before requesting its first chunk.
 */
function afterCheckpoint(
  scheduler: CheckpointScheduler,
  session: Session,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    await scheduler.flushMandatory(session, 'model-boundary')
    yield* next()
  })()
}

/** Materialize the canonical result for a call cancelled before tool dispatch. */
function abortedBeforeDispatchResult(): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
  }
}

/**
 * Install semantic checkpoint listeners and the configurable write-behind scheduler.
 *
 * The default policy is time-based. The strategy registry is deliberately separate
 * from the Session and persistence seams, so another plugin can register a policy
 * without changing the MySQL, JSONL, or SQLite implementations.
 */
export function apply(ctx: Context, rawConfig?: Config): void {
  const config = resolveConfig(rawConfig)
  const policy = createCheckpointPolicy(config)
  const scheduler = new CheckpointScheduler(ctx, policy, config)

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    scheduler.observe(session, event)
  })
  ctx.on('session/disposed', (session: Session) => {
    scheduler.forget(session)
  })
  ctx.effect(() => async () => scheduler.dispose(), 'session-checkpoint-policy shutdown')

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    if (options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId)
    return session === undefined ? next() : afterCheckpoint(scheduler, session, next)
  })

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (exec.agent === undefined || exec.parent !== undefined) return next()
    await scheduler.flushMandatory(exec.agent.session, 'tool-boundary')
    if (exec.signal.aborted) return abortedBeforeDispatchResult()
    return next()
  })

  // Before each request, persist everything committed by the preceding step;
  // the first step's call is an intentional no-op beyond any prompt intake.
  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    await scheduler.flushMandatory(agent.session, 'step-boundary')
    return next()
  })
}
