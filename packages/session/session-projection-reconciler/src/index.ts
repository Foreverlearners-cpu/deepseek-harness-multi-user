/**
 * Operator-triggered rebuilding of session projections from an application-owned
 * authoritative source into named, idempotent sinks.
 * @module @deepseek-ai/dsh-session-projection-reconciler
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'

/** Opaque position at the start of an authoritative source page. */
export type SessionProjectionCursor = Branded<'SessionProjectionCursor'>

/**
 * Brand a source-owned resume position.
 * @param value - Opaque non-empty cursor returned by the authoritative source.
 * @returns the same string with the projection cursor brand.
 */
export function SessionProjectionCursor(value: string): SessionProjectionCursor {
  return value as SessionProjectionCursor
}

/** Fixed transport-neutral session projection record. */
export interface SessionProjectionRecord {
  tenantId: string
  userId: string
  sessionId: string
  messageId: string
  revision: number
  status: string
  visibility: string
  role: string
  visibleText: string
  occurredAt: string
  deleted: boolean
}

/** One page read from the authoritative application source. */
export interface SessionProjectionPage {
  /** Records in authoritative source order. */
  records: readonly SessionProjectionRecord[]
  /** Start position of the next page; omission marks completion. */
  nextCursor?: SessionProjectionCursor
}

/** Input for one authoritative page read. */
export interface SessionProjectionPageRequest {
  /** Start position of this page; omission selects the source beginning. */
  cursor?: SessionProjectionCursor
  /** Requested positive page size bounded by service configuration. */
  batchSize: number
  /** Optional tenant restriction that every returned record must match. */
  tenantId?: string
  /** Job-wide cancellation signal. */
  signal: AbortSignal
}

/** Application-injected authoritative snapshot reader. */
export interface SessionProjectionSource {
  /**
   * Read one stable page.
   * @param request - page start, bounded size, optional tenant, and cancellation.
   * @returns ordered records and an advancing next cursor, or no cursor at completion.
   */
  readPage(request: SessionProjectionPageRequest): Promise<SessionProjectionPage>
}

/** Named projection destination registered by an adapter package. */
export interface SessionProjectionSink {
  /** Stable, non-empty registration name used by progress and failures. */
  name: string
  /**
   * Apply one record idempotently.
   * @param record - authoritative record, including tombstone state.
   * @param signal - job-wide cancellation signal.
   */
  apply(record: SessionProjectionRecord, signal: AbortSignal): Promise<void>
}

/** Sink execution policy selected explicitly for a reconcile job. */
export type SessionProjectionSinkStrategy = 'sequential'

/** Input for one operator-triggered reconcile job. */
export interface SessionProjectionReconcileRequest {
  /** Resume position previously returned by this service. */
  cursor?: SessionProjectionCursor
  /** Positive source page size no greater than `Config.maxBatchSize`. */
  batchSize: number
  /** Optional tenant restriction enforced before any sink receives a record. */
  tenantId?: string
  /** Explicit record-major, registration-order sink execution. */
  sinkStrategy: SessionProjectionSinkStrategy
  /** Optional caller cancellation composed with service disposal. */
  signal?: AbortSignal
}

/** Non-success reason that retains a safe page-level resume position. */
export type SessionProjectionReconcileFailureCode =
  | 'aborted'
  | 'invalid-page'
  | 'source-failed'
  | 'sink-failed'

/** Successful reconcile result. */
export interface SessionProjectionReconcileCompleted {
  status: 'completed'
  /** Terminal source position; omission means the source began and ended on one page. */
  cursor?: SessionProjectionCursor
  processed: number
  pages: number
}

/** Failed or cancelled reconcile result with a page-level resume position. */
export interface SessionProjectionReconcileStopped {
  status: 'failed' | 'aborted'
  code: SessionProjectionReconcileFailureCode
  /** Start of the page that must be replayed; omission means restart from the beginning. */
  cursor?: SessionProjectionCursor
  processed: number
  pages: number
  /** Sink that rejected, without record content or exception details. */
  sinkName?: string
}

/** Outcome of one reconcile job. */
export type SessionProjectionReconcileResult =
  | SessionProjectionReconcileCompleted
  | SessionProjectionReconcileStopped

/** Privacy-bounded point-in-time service state. */
export type SessionProjectionReconcilerHealth =
  | { status: 'idle' }
  | {
    status: 'running'
    cursor?: SessionProjectionCursor
    processed: number
    pages: number
    tenantId?: string
    sinkName?: string
  }

/** Reconciler configuration. */
export interface Config {
  /** Deployment limit for an individual source page. */
  maxBatchSize: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionProjectionReconciler: SessionProjectionReconcilerService
  }
}

interface MutableProgress {
  cursor?: SessionProjectionCursor
  processed: number
  pages: number
  tenantId?: string
  sinkName: string | undefined
}

function stopped(
  status: 'failed' | 'aborted',
  code: SessionProjectionReconcileFailureCode,
  progress: MutableProgress,
): SessionProjectionReconcileStopped {
  return {
    status,
    code,
    ...(progress.cursor === undefined ? {} : { cursor: progress.cursor }),
    processed: progress.processed,
    pages: progress.pages,
    ...(progress.sinkName === undefined ? {} : { sinkName: progress.sinkName }),
  }
}

/** Single-job service for authoritative session projection rebuilding. */
export class SessionProjectionReconcilerService extends Service {
  static Config: z<Config> = z.object({
    maxBatchSize: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  })

  private readonly maxBatchSize: number
  private readonly sinks = new Map<string, SessionProjectionSink>()
  private readonly lifetime = new AbortController()
  private source: SessionProjectionSource | undefined
  private active: Promise<SessionProjectionReconcileResult> | undefined
  private progress: MutableProgress | undefined

  /**
   * @param ctx - Host context that owns registrations and active reconciliation.
   * @param config - explicit deployment page-size limit.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionProjectionReconciler')
    this.maxBatchSize = config.maxBatchSize
    this.ctx.effect(() => async () => {
      this.lifetime.abort()
      await this.active
    }, 'session-projection-reconciler')
  }

  /**
   * Register the only authoritative source.
   * @param source - application-owned paginated snapshot reader.
   * @returns idempotent disposer for this exact registration.
   * @throws when a source is already registered.
   */
  registerSource(source: SessionProjectionSource): () => void {
    if (this.source !== undefined) throw new Error('Session projection source is already registered')
    this.source = source
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.source === source) this.source = undefined
    }
  }

  /**
   * Register one named sink.
   * @param sink - idempotent destination adapter.
   * @returns idempotent disposer for this exact registration.
   * @throws when its name is empty or already registered.
   */
  registerSink(sink: SessionProjectionSink): () => void {
    if (sink.name.trim().length === 0) throw new Error('Session projection sink name must not be empty')
    if (this.sinks.has(sink.name)) throw new Error(`Session projection sink '${sink.name}' is already registered`)
    this.sinks.set(sink.name, sink)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.sinks.get(sink.name) === sink) this.sinks.delete(sink.name)
    }
  }

  /**
   * Run one authoritative reconciliation to the currently registered sinks.
   * A page cursor advances only after every record reaches every sink. Source,
   * sink, validation, and cancellation failures stop immediately and return the
   * current page start for idempotent replay.
   * @param request - resume position, bounded size, tenant, strategy, and cancellation.
   * @returns completion or a privacy-bounded resumable failure.
   * @throws when configuration is missing, invalid, or another job is active.
   */
  reconcile(request: SessionProjectionReconcileRequest): Promise<SessionProjectionReconcileResult> {
    if (this.active !== undefined) throw new Error('Session projection reconcile job is already running')
    if (this.source === undefined) throw new Error('Session projection source is not registered')
    if (this.sinks.size === 0) throw new Error('At least one session projection sink must be registered')
    if (!Number.isSafeInteger(request.batchSize) || request.batchSize < 1 || request.batchSize > this.maxBatchSize) {
      throw new Error(`Session projection batchSize must be between 1 and ${this.maxBatchSize}`)
    }
    if (request.sinkStrategy !== 'sequential') throw new Error('Unsupported session projection sink strategy')

    const source = this.source
    const sinks = [...this.sinks.values()]
    const signal = request.signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([this.lifetime.signal, request.signal])
    const progress: MutableProgress = {
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      processed: 0,
      pages: 0,
      sinkName: undefined,
      ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
    }
    this.progress = progress
    const operation = this.run(source, sinks, request.batchSize, signal, progress)
    this.active = operation
    void operation.finally(() => {
      if (this.active === operation) {
        this.active = undefined
        this.progress = undefined
      }
    }).catch(() => {})
    return operation
  }

  /**
   * Return current job progress without records, visible text, or exception details.
   * @returns a detached idle or running snapshot.
   */
  health(): SessionProjectionReconcilerHealth {
    const progress = this.progress
    if (progress === undefined) return { status: 'idle' }
    return {
      status: 'running',
      ...(progress.cursor === undefined ? {} : { cursor: progress.cursor }),
      processed: progress.processed,
      pages: progress.pages,
      ...(progress.tenantId === undefined ? {} : { tenantId: progress.tenantId }),
      ...(progress.sinkName === undefined ? {} : { sinkName: progress.sinkName }),
    }
  }

  private async run(
    source: SessionProjectionSource,
    sinks: readonly SessionProjectionSink[],
    batchSize: number,
    signal: AbortSignal,
    progress: MutableProgress,
  ): Promise<SessionProjectionReconcileResult> {
    while (true) {
      if (signal.aborted) return stopped('aborted', 'aborted', progress)
      const pageCursor = progress.cursor
      let page: SessionProjectionPage
      try {
        page = await source.readPage({
          ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
          batchSize,
          ...(progress.tenantId === undefined ? {} : { tenantId: progress.tenantId }),
          signal,
        })
      } catch {
        return signal.aborted
          ? stopped('aborted', 'aborted', progress)
          : stopped('failed', 'source-failed', progress)
      }
      if (signal.aborted) return stopped('aborted', 'aborted', progress)
      if (
        page.records.length > batchSize
        || (page.records.length === 0 && page.nextCursor !== undefined)
        || (page.nextCursor !== undefined && page.nextCursor === pageCursor)
      ) {
        return stopped('failed', 'invalid-page', progress)
      }
      if (
        progress.tenantId !== undefined
        && page.records.some(record => record.tenantId !== progress.tenantId)
      ) {
        return stopped('failed', 'invalid-page', progress)
      }

      for (const record of page.records) {
        for (const sink of sinks) {
          if (signal.aborted) return stopped('aborted', 'aborted', progress)
          progress.sinkName = sink.name
          try {
            await sink.apply(record, signal)
          } catch {
            return signal.aborted
              ? stopped('aborted', 'aborted', progress)
              : stopped('failed', 'sink-failed', progress)
          }
          if (signal.aborted) return stopped('aborted', 'aborted', progress)
        }
        progress.sinkName = undefined
        progress.processed += 1
      }

      progress.pages += 1
      if (page.nextCursor === undefined) {
        return {
          status: 'completed',
          ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
          processed: progress.processed,
          pages: progress.pages,
        }
      }
      progress.cursor = page.nextCursor
    }
  }
}

export default SessionProjectionReconcilerService
