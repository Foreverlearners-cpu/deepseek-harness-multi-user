import { Context, Service } from '@deepseek-ai/cordis'
import type {
  KafkaConsumedMessage,
  KafkaSubscribeRequest,
  KafkaSubscription,
} from '@deepseek-ai/dsh-kafka'

/** In-process Kafka stand-in that commits only after the awaited handler returns. */
export class FakeKafka extends Service {
  readonly subscriptions = new Map<string, KafkaSubscribeRequest>()
  readonly committed: Array<{ topic: string; partition: number; offset: bigint }> = []
  private inFlight?: Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'kafka')
  }

  /**
   * Register one sequential handler owned by the calling plugin fiber.
   * @param request - unique identity, group, topics, mode, and awaited handler.
   * @returns a subscription whose close waits for the active handler, then removes the registration.
   */
  async subscribe(request: KafkaSubscribeRequest): Promise<KafkaSubscription> {
    if (this.subscriptions.has(request.id)) throw new Error('duplicate subscription')
    this.subscriptions.set(request.id, request)
    const owned = this.ctx.effect(() => async () => {
      await this.inFlight
      this.subscriptions.delete(request.id)
    }, `kafka.subscribe:${request.id}`)
    return {
      id: request.id,
      done: new Promise(() => {}),
      close: async () => { await owned() },
    }
  }

  /**
   * Deliver one record and commit only if the handler settles successfully.
   * @param message - binary record presented to the registered handler.
   */
  async deliver(message: KafkaConsumedMessage): Promise<void> {
    const request = [...this.subscriptions.values()][0]
    if (request === undefined) throw new Error('no subscription')
    const running = Promise.resolve(request.handle(message))
    this.inFlight = running.then(() => undefined, () => undefined)
    try {
      await running
    } finally {
      this.inFlight = undefined
    }
    this.committed.push({
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
    })
  }
}

/** In-process Redis stand-in that records `DEL` keys and can fail the next command. */
export class FakeRedis extends Service {
  readonly keys = new Set<string>()
  readonly deleted: string[] = []
  failNext = false
  delayDel?: Promise<void>
  onDelStart?: () => void

  constructor(ctx: Context) {
    super(ctx, 'redis')
  }

  /**
   * Run one callback against a `del`-only client.
   * @param callback - Redis work scoped to this callback.
   * @returns the callback result.
   */
  async withClient<T>(callback: (client: { del(key: string): Promise<number> }) => T | Promise<T>): Promise<T> {
    return await callback({
      del: async (key: string) => {
        this.onDelStart?.()
        if (this.delayDel !== undefined) await this.delayDel
        if (this.failNext) {
          this.failNext = false
          throw new Error('redis command failed')
        }
        this.deleted.push(key)
        const existed = this.keys.delete(key)
        return existed ? 1 : 0
      },
    })
  }
}
