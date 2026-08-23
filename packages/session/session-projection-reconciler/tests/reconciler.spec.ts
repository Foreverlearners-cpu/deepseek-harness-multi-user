import { Context } from '@deepseek-ai/cordis'
import SessionProjectionReconcilerService, {
  SessionProjectionCursor,
  type SessionProjectionPage,
  type SessionProjectionRecord,
  type SessionProjectionSink,
  type SessionProjectionSource,
} from '@deepseek-ai/dsh-session-projection-reconciler'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fibers: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
})

function record(messageId: string, tenantId = 'tenant-a'): SessionProjectionRecord {
  return {
    tenantId,
    userId: 'user-1',
    sessionId: 'session-1',
    messageId,
    revision: 1,
    status: 'ready',
    visibility: 'visible',
    role: 'assistant',
    visibleText: `private-${messageId}`,
    occurredAt: '2026-08-23T00:00:00.000Z',
    deleted: false,
  }
}

async function setup(maxBatchSize = 10): Promise<{
  ctx: Context
  service: SessionProjectionReconcilerService
}> {
  const ctx = new Context()
  const fiber = await ctx.plugin(SessionProjectionReconcilerService, { maxBatchSize })
  fibers.push(fiber)
  return { ctx, service: ctx.sessionProjectionReconciler }
}

function source(readPage: SessionProjectionSource['readPage']): SessionProjectionSource {
  return { readPage }
}

function sink(name: string, apply: SessionProjectionSink['apply']): SessionProjectionSink {
  return { name, apply }
}

describe('SessionProjectionReconcilerService', () => {
  it('reconciles multiple pages in record-major registration order', async () => {
    const { service } = await setup(2)
    const second = SessionProjectionCursor('page-2')
    const reads: Array<{ cursor?: string; batchSize: number; tenantId?: string }> = []
    service.registerSource(source(async (request): Promise<SessionProjectionPage> => {
      reads.push({ cursor: request.cursor, batchSize: request.batchSize, tenantId: request.tenantId })
      return request.cursor === undefined
        ? { records: [record('m1'), record('m2')], nextCursor: second }
        : { records: [record('m3')] }
    }))
    const calls: string[] = []
    service.registerSink(sink('redis', async (item) => { calls.push(`redis:${item.messageId}`) }))
    service.registerSink(sink('search', async (item) => { calls.push(`search:${item.messageId}`) }))

    await expect(service.reconcile({
      batchSize: 2,
      tenantId: 'tenant-a',
      sinkStrategy: 'sequential',
    })).resolves.toEqual({ status: 'completed', cursor: second, processed: 3, pages: 2 })
    expect(reads).toEqual([
      { cursor: undefined, batchSize: 2, tenantId: 'tenant-a' },
      { cursor: second, batchSize: 2, tenantId: 'tenant-a' },
    ])
    expect(calls).toEqual([
      'redis:m1', 'search:m1',
      'redis:m2', 'search:m2',
      'redis:m3', 'search:m3',
    ])
    expect(service.health()).toEqual({ status: 'idle' })
  })

  it('accepts an empty terminal page and rejects non-advancing pages', async () => {
    const { service } = await setup()
    const disposeSource = service.registerSource(source(async () => ({ records: [] })))
    service.registerSink(sink('sink', async () => {}))

    await expect(service.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })).resolves.toEqual({
      status: 'completed', processed: 0, pages: 1,
    })
    disposeSource()

    service.registerSource(source(async () => ({
      records: [],
      nextCursor: SessionProjectionCursor('next'),
    })))
    await expect(service.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })).resolves.toMatchObject({
      status: 'failed', code: 'invalid-page', processed: 0, pages: 0,
    })
  })

  it('rejects a stalled cursor and an oversized source page', async () => {
    const { service } = await setup(1)
    const start = SessionProjectionCursor('same')
    let oversized = false
    service.registerSource(source(async () => oversized
      ? { records: [record('m1'), record('m2')] }
      : { records: [record('m1')], nextCursor: start }))
    service.registerSink(sink('sink', async () => {}))

    await expect(service.reconcile({
      cursor: start,
      batchSize: 1,
      sinkStrategy: 'sequential',
    })).resolves.toMatchObject({ status: 'failed', code: 'invalid-page', cursor: start })
    oversized = true
    await expect(service.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })).resolves.toMatchObject({
      status: 'failed', code: 'invalid-page', processed: 0,
    })
  })

  it('stops on the first sink failure and returns the current page cursor', async () => {
    const { service } = await setup()
    const cursor = SessionProjectionCursor('resume-page')
    service.registerSource(source(async () => ({ records: [record('m1'), record('m2')] })))
    const calls: string[] = []
    service.registerSink(sink('first', async (item) => { calls.push(`first:${item.messageId}`) }))
    service.registerSink(sink('failing', async (item) => {
      calls.push(`failing:${item.messageId}`)
      throw new Error(`must not disclose ${item.visibleText}`)
    }))
    service.registerSink(sink('later', async (item) => { calls.push(`later:${item.messageId}`) }))

    const result = await service.reconcile({ cursor, batchSize: 2, sinkStrategy: 'sequential' })
    expect(result).toEqual({
      status: 'failed',
      code: 'sink-failed',
      cursor,
      processed: 0,
      pages: 0,
      sinkName: 'failing',
    })
    expect(calls).toEqual(['first:m1', 'failing:m1'])
    expect(JSON.stringify(result)).not.toContain('private-m1')
  })

  it('returns source failure without exception or record disclosure', async () => {
    const { service } = await setup()
    service.registerSource(source(async () => { throw new Error('private-m1') }))
    service.registerSink(sink('sink', async () => {}))

    const result = await service.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })
    expect(result).toMatchObject({ status: 'failed', code: 'source-failed' })
    expect(JSON.stringify(result)).not.toContain('private-m1')
  })

  it('honors abort before a read and while a sink is active', async () => {
    const { service } = await setup()
    const readPage = vi.fn(async () => ({ records: [record('m1')] }))
    service.registerSource(source(readPage))
    service.registerSink(sink('sink', async () => {}))
    const before = new AbortController()
    before.abort()

    await expect(service.reconcile({
      batchSize: 1,
      sinkStrategy: 'sequential',
      signal: before.signal,
    })).resolves.toMatchObject({ status: 'aborted', code: 'aborted' })
    expect(readPage).not.toHaveBeenCalled()

    const active = new AbortController()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    const disposeSink = service.registerSink(sink('blocking', async (_item, signal) => {
      entered.resolve(signal)
      await release.promise
    }))
    const operation = service.reconcile({
      batchSize: 1,
      sinkStrategy: 'sequential',
      signal: active.signal,
    })
    await entered.promise
    active.abort()
    release.resolve(undefined)
    await expect(operation).resolves.toMatchObject({ status: 'aborted', code: 'aborted' })
    disposeSink()
  })

  it('rejects a concurrent job while preserving active progress privacy', async () => {
    const { service } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    service.registerSource(source(async () => {
      entered.resolve(undefined)
      await release.promise
      return { records: [record('m1')] }
    }))
    service.registerSink(sink('sink', async () => {}))

    const first = service.reconcile({ batchSize: 1, tenantId: 'tenant-a', sinkStrategy: 'sequential' })
    await entered.promise
    expect(() => service.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })).toThrow(
      'already running',
    )
    const health = service.health()
    expect(health).toEqual({
      status: 'running', processed: 0, pages: 0, tenantId: 'tenant-a',
    })
    expect(JSON.stringify(health)).not.toContain('visibleText')
    release.resolve(undefined)
    await first
  })

  it('enforces tenant isolation before invoking a sink', async () => {
    const { service } = await setup()
    service.registerSource(source(async (request) => {
      expect(request.tenantId).toBe('tenant-a')
      return { records: [record('m1', 'tenant-b')] }
    }))
    const apply = vi.fn(async () => {})
    service.registerSink(sink('sink', apply))

    await expect(service.reconcile({
      batchSize: 1,
      tenantId: 'tenant-a',
      sinkStrategy: 'sequential',
    })).resolves.toMatchObject({ status: 'failed', code: 'invalid-page' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('validates registrations, job configuration, and registration disposal', async () => {
    const { service } = await setup(2)
    const sourceValue = source(async () => ({ records: [] }))
    const disposeSource = service.registerSource(sourceValue)
    expect(() => service.registerSource(sourceValue)).toThrow('already registered')
    disposeSource()
    disposeSource()
    expect(() => service.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })).toThrow(
      'source is not registered',
    )
    service.registerSource(sourceValue)
    expect(() => service.registerSink(sink(' ', async () => {}))).toThrow('must not be empty')
    const sinkValue = sink('sink', async () => {})
    const disposeSink = service.registerSink(sinkValue)
    expect(() => service.registerSink(sinkValue)).toThrow('already registered')
    expect(() => service.reconcile({ batchSize: 0, sinkStrategy: 'sequential' })).toThrow('between 1 and 2')
    expect(() => service.reconcile({ batchSize: 3, sinkStrategy: 'sequential' })).toThrow('between 1 and 2')
    expect(() => service.reconcile({
      batchSize: 1,
      sinkStrategy: 'parallel' as 'sequential',
    })).toThrow('Unsupported')
    disposeSink()
    disposeSink()
    expect(() => service.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })).toThrow(
      'At least one',
    )
  })

  it('aborts active work and waits for quiescence during service disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(SessionProjectionReconcilerService, { maxBatchSize: 1 })
    const service = ctx.sessionProjectionReconciler
    const entered = Promise.withResolvers<AbortSignal>()
    const released = Promise.withResolvers<undefined>()
    service.registerSource(source(async () => ({ records: [record('m1')] })))
    service.registerSink(sink('sink', async (_item, signal) => {
      entered.resolve(signal)
      await released.promise
    }))
    const operation = service.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })
    const signal = await entered.promise
    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
    expect(disposed).toBe(false)
    released.resolve(undefined)
    await disposal
    await expect(operation).resolves.toMatchObject({ status: 'aborted' })
  })
})
