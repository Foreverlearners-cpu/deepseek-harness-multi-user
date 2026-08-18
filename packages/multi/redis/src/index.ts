/**
 * Host-only Redis connection service. It validates one standalone target,
 * verifies connectivity during startup, admits callback-scoped client use,
 * and drains admitted callbacks before closing the client.
 * @module @deepseek-ai/dsh-redis
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { createClient } from '@redis/client'
import type { RedisClientType } from '@redis/client'

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const UNAVAILABLE_MESSAGE = 'redis connection service is unavailable or closing'

/** Redis connection service configuration. */
export interface Config {
  /** Standalone `redis:` or `rediss:` URL; Schemastery treats it as a secret. */
  url: string
  /** Initial connection and `PING` timeout in milliseconds; defaults to `10000` and must not exceed `2147483647`. */
  connectTimeoutMs?: number
}

interface RedisSpec {
  url: string
  connectTimeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    redis: Redis
  }
}

/** Resolve and validate the Redis target without copying it into diagnostics. */
function resolve(config: Required<Config>): RedisSpec {
  let target: URL
  try {
    target = new URL(config.url)
  } catch {
    throw new Error('redis url must be a valid absolute redis: or rediss: URL')
  }
  if (target.protocol !== 'redis:' && target.protocol !== 'rediss:') {
    throw new Error('redis url must use the redis: or rediss: scheme')
  }
  if (target.hostname.length === 0) {
    throw new Error('redis url must name a host')
  }
  return {
    url: config.url,
    connectTimeoutMs: config.connectTimeoutMs,
  }
}

/**
 * Redis client service exposed as `ctx.redis`. Startup connects and sends
 * `PING`; failure rejects plugin activation. {@link withClient} shares the
 * owned non-blocking command client only for the callback lifetime.
 */
export class Redis extends Service {
  static Config: z<Config> = z.object({
    url: z.string().min(1).role('secret').required(),
    connectTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CONNECT_TIMEOUT_MS),
  })

  private readonly client: RedisClientType
  private readonly spec: RedisSpec
  private readonly operations = new Set<Promise<void>>()
  private accepting = false
  private errorReported = false

  /**
   * Create the disconnected client from validated configuration.
   * @param ctx - Owning Host context.
   * @param config - Redis target and startup timeout.
   * @throws when the URL is invalid or does not identify a standalone Redis TCP target.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'redis')
    this.spec = resolve(config as Required<Config>)
    this.client = createClient({
      url: this.spec.url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: this.spec.connectTimeoutMs,
        reconnectStrategy: false,
      },
    })
    this.client.on('error', this.onError)
    this.client.on('ready', this.onReady)
  }

  /** Verify startup connectivity and bind client teardown to the service fiber. */
  async [Service.init](): Promise<void> {
    this.ctx.effect(() => async () => this.close(), 'redis.client')
    await this.open()
    this.accepting = true
  }

  /**
   * Run one callback with the shared non-blocking command client. Admission
   * precedes callback invocation, so disposal waits for accepted operations.
   * The callback must settle its commands and must not retain or close the client.
   * @param callback - Redis work scoped to this callback.
   * @returns the callback result.
   * @throws when the service is unavailable or closing, or when the callback rejects.
   */
  async withClient<T>(callback: (client: RedisClientType) => T | Promise<T>): Promise<T> {
    if (!this.accepting || !this.client.isReady) {
      throw new Error(UNAVAILABLE_MESSAGE)
    }

    const operation = Promise.withResolvers<void>()
    this.operations.add(operation.promise)
    try {
      return await callback(this.client)
    } finally {
      this.operations.delete(operation.promise)
      operation.resolve()
    }
  }

  /** Connect and verify `PING` within one total startup deadline. */
  private async open(): Promise<void> {
    const startup = (async () => {
      await this.client.connect()
      await this.client.ping()
    })()
    const deadline = Promise.withResolvers<never>()
    const timer = setTimeout(() => {
      this.client.destroy()
      deadline.reject(new Error(`redis startup timed out after ${this.spec.connectTimeoutMs}ms`))
    }, this.spec.connectTimeoutMs)
    try {
      await Promise.race([startup, deadline.promise])
    } catch (error: unknown) {
      await Promise.allSettled([startup])
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** Stop admission, drain callbacks, close with error containment, then remove listeners. */
  private async close(): Promise<void> {
    this.accepting = false
    await Promise.all([...this.operations])
    try {
      if (this.client.isOpen) await this.client.close()
    } finally {
      this.client.off('error', this.onError)
      this.client.off('ready', this.onReady)
    }
  }

  /** Report one generic connection failure per interval without copying endpoint or credential details. */
  private readonly onError = (): void => {
    if (this.errorReported) return
    this.errorReported = true
    this.ctx.logger.warn('redis: connection error; commands fail while the client is unavailable')
  }

  /** Permit one diagnostic for the next unavailable interval. */
  private readonly onReady = (): void => {
    this.errorReported = false
  }
}

export default Redis
