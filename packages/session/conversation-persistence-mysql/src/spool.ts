import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppendMessageInput, ModelAttempt } from './index.ts'

/** Durable final-message command retained while MySQL is unavailable. */
export interface SpoolTask {
  operationId: string
  userId: string
  sessionId: string
  messages: AppendMessageInput[]
  attempts: ModelAttempt[]
  reason: { kind: string; error?: { code?: string; message?: string } }
  createdAt: number
  retryCount: number
}

type SpoolRecord =
  | { state: 'pending'; task: SpoolTask }
  | { state: 'saving'; operationId: string; at: number }
  | { state: 'saved'; operationId: string; at: number }
  | { state: 'save_failed'; operationId: string; at: number; retryCount: number; error: string }

/** Small JSONL WAL for assembled message writes; chunks are never accepted. */
export class DurableMessageSpool {
  private readonly file: string
  private readonly tasks = new Map<string, SpoolTask>()
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private saving = false

  constructor(
    private readonly root: string,
    private readonly userId: string,
    private readonly retryMs: number,
    private readonly save: (task: SpoolTask) => Promise<void>,
  ) {
    this.file = join(root, 'conversation-message-spool.jsonl')
  }

  /** Load pending tasks from the JSONL journal and start retry scheduling. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    try {
      const text = await readFile(this.file, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        let record: SpoolRecord
        try { record = JSON.parse(line) as SpoolRecord } catch { continue }
        if (record.state === 'pending') {
          if (record.task.userId === this.userId) this.tasks.set(record.task.operationId, record.task)
        } else if (record.state === 'saved') {
          this.tasks.delete(record.operationId)
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.schedule()
  }

  /** Append a final-message command to the journal for eventual retry.
   * @param task Message and attempt data to retain.
   * @returns Stable operation id assigned to the journal record.
   */
  async enqueue(task: Omit<SpoolTask, 'operationId' | 'createdAt' | 'retryCount'> & Partial<Pick<SpoolTask, 'operationId' | 'createdAt' | 'retryCount'>>): Promise<string> {
    const operationId = task.operationId ?? randomUUID()
    const full: SpoolTask = {
      ...task,
      operationId,
      userId: this.userId,
      createdAt: task.createdAt ?? Date.now(),
      retryCount: task.retryCount ?? 0,
      messages: structuredClone(task.messages),
      attempts: structuredClone(task.attempts),
    }
    this.tasks.set(operationId, full)
    await this.append({ state: 'pending', task: full })
    this.schedule()
    return operationId
  }

  /** Stop retries after queued journal writes have settled. */
  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.chain
  }

  /** Number of pending final-message tasks currently retained. */
  get pendingCount(): number { return this.tasks.size }

  private schedule(): void {
    if (this.closed || this.timer !== undefined || this.saving) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, Math.max(250, this.retryMs))
  }

  private async drain(): Promise<void> {
    if (this.closed || this.saving) return
    this.saving = true
    try {
      for (const task of [...this.tasks.values()]) {
        if (this.closed) break
        await this.append({ state: 'saving', operationId: task.operationId, at: Date.now() })
        try {
          await this.save(task)
          this.tasks.delete(task.operationId)
          await this.append({ state: 'saved', operationId: task.operationId, at: Date.now() })
        } catch (error: unknown) {
          task.retryCount += 1
          await this.append({ state: 'save_failed', operationId: task.operationId, at: Date.now(), retryCount: task.retryCount, error: String(error) })
        }
      }
    } finally {
      this.saving = false
      if (this.tasks.size > 0) this.schedule()
    }
  }

  private append(record: SpoolRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, line, 'utf8')
    })
    return this.chain
  }
}
