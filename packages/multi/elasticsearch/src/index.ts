/**
 * Host-only Elasticsearch client service. It verifies connectivity during
 * startup, lends the official client only to operation callbacks, and drains
 * admitted callbacks before closing the transport.
 * @module @deepseek-ai/dsh-elasticsearch
 */

import { Context, FiberState, Service, type Fiber } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { Client } from '@elastic/elasticsearch'
import type { ClientOptions } from '@elastic/elasticsearch'

const AUTH_FIELDS = new Set(['username', 'password', 'apiKey', 'bearer'])
const SHA_256_FINGERPRINT = /^(?:[0-9a-f]{64}|(?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/i

/** Elasticsearch authentication fields; exactly one complete strategy may be configured. */
export interface ElasticsearchAuthConfig {
  /** Basic-auth username; requires {@link password}. */
  username?: string
  /** Basic-auth password; requires {@link username}. */
  password?: string
  /** Base64-encoded Elasticsearch API key. */
  apiKey?: string
  /** Bearer or service-account token. */
  bearer?: string
}

/** Elasticsearch connection service configuration. */
export interface Config {
  /** Absolute HTTP(S) Elasticsearch node URL without credentials, a query, or a fragment. */
  node: string
  /** Optional bootstrap authentication; at most one strategy is accepted. */
  auth?: ElasticsearchAuthConfig
  /** SHA-256 CA fingerprint as 64 hex digits or 32 colon-delimited hex bytes. */
  caFingerprint?: string
  /** Explicit opt-in for plaintext HTTP, restricted to trusted local deployments; defaults to `false`. */
  allowInsecureHttp?: boolean
  /** Official-client retry default; operation callbacks may override it per request. */
  maxRetries: number
  /** Official-client request-timeout default in milliseconds; operation callbacks may override it per request. */
  requestTimeoutMs: number
  /** Maximum startup and connection-pool ping duration in milliseconds; at most `MAX_TIMER_DELAY_MS`. */
  pingTimeoutMs: number
}

type ElasticsearchHiddenMember =
  | 'close'
  | 'child'
  | 'connectionPool'
  | 'diagnostic'
  | 'serializer'
  | 'name'

type BorrowedElasticsearchMember<Value> = Value extends { transport: unknown }
  ? Omit<Value, 'transport'> & { readonly transport: never }
  : Value

/** Official Elasticsearch API borrowed for one operation, with direct owner-only members unavailable. */
export type ElasticsearchClient = {
  [Member in Exclude<keyof Client, ElasticsearchHiddenMember | 'transport'>]:
  BorrowedElasticsearchMember<Client[Member]>
} & { readonly transport: never }

declare module '@deepseek-ai/cordis' {
  interface Context {
    elasticsearch: ElasticsearchService
  }
}

const authSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1).role('secret'),
  apiKey: z.string().min(1).role('secret'),
  bearer: z.string().min(1).role('secret'),
})

/** Resolve and validate client options before constructing any transport state. */
function resolveClientOptions(config: Config): ClientOptions {
  let node: URL
  try {
    node = new URL(config.node)
  } catch {
    throw new Error('elasticsearch: node must be a valid absolute URL')
  }
  if (node.protocol !== 'https:' && node.protocol !== 'http:') {
    throw new Error(`elasticsearch: node must use http or https, got ${node.protocol}`)
  }
  if (node.username.length > 0 || node.password.length > 0) {
    throw new Error('elasticsearch: node URL must not contain credentials; use auth')
  }
  const nodeWithoutQueryOrFragment = new URL(node)
  nodeWithoutQueryOrFragment.search = ''
  nodeWithoutQueryOrFragment.hash = ''
  if (nodeWithoutQueryOrFragment.href !== node.href) {
    throw new Error('elasticsearch: node URL must not contain a query or fragment')
  }
  if (node.protocol === 'http:' && config.allowInsecureHttp !== true) {
    throw new Error('elasticsearch: plaintext HTTP requires allowInsecureHttp: true')
  }
  if (config.caFingerprint !== undefined && node.protocol !== 'https:') {
    throw new Error('elasticsearch: caFingerprint requires an HTTPS node')
  }
  if (config.caFingerprint !== undefined && !SHA_256_FINGERPRINT.test(config.caFingerprint)) {
    throw new Error('elasticsearch: caFingerprint must be a SHA-256 fingerprint')
  }

  const auth = resolveAuth(config.auth)
  return {
    node: config.node,
    ...(auth === undefined ? {} : { auth }),
    ...(config.caFingerprint === undefined ? {} : { caFingerprint: config.caFingerprint }),
    maxRetries: config.maxRetries,
    requestTimeout: config.requestTimeoutMs,
    pingTimeout: config.pingTimeoutMs,
    redaction: { type: 'replace' },
  }
}

/** Validate authentication as one complete official-client strategy. */
function resolveAuth(auth: ElasticsearchAuthConfig | undefined): ClientOptions['auth'] {
  if (auth === undefined) return undefined
  const unsupportedFields = Object.keys(auth).filter(field => !AUTH_FIELDS.has(field))
  if (unsupportedFields.length > 0) {
    const fields = unsupportedFields.map(field => JSON.stringify(field)).join(', ')
    throw new Error(`elasticsearch: unsupported auth field ${fields}`)
  }
  const hasUsername = auth.username !== undefined
  const hasPassword = auth.password !== undefined
  if (hasUsername !== hasPassword) {
    throw new Error('elasticsearch: auth.username and auth.password must be configured together')
  }
  const strategyCount = Number(hasUsername) + Number(auth.apiKey !== undefined) + Number(auth.bearer !== undefined)
  if (strategyCount === 0) return undefined
  if (strategyCount !== 1) {
    throw new Error('elasticsearch: auth must configure exactly one of basic, apiKey, or bearer')
  }
  if (hasUsername) {
    return { username: auth.username as string, password: auth.password as string }
  }
  if (auth.apiKey !== undefined) return { apiKey: auth.apiKey }
  return { bearer: auth.bearer as string }
}

/**
 * Elasticsearch client service exposed as `ctx.elasticsearch`. Startup pings
 * the configured node; failure rejects plugin activation. Operations are
 * admitted only while the service is active and share one official client.
 */
export class ElasticsearchService extends Service {
  static Config: z<Config> = z.object({
    node: z.string().min(1).required(),
    auth: authSchema,
    caFingerprint: z.string().min(1),
    allowInsecureHttp: z.boolean().default(false),
    maxRetries: z.natural().required(),
    requestTimeoutMs: z.natural().min(1).required(),
    pingTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).required(),
  })

  private readonly client: Client
  /** Providing fiber; Cordis service methods expose caller-scoped `this.ctx`. */
  private readonly ownerFiber: Fiber
  private readonly startupPingTimeoutMs: number
  private readonly operations = new Set<Promise<void>>()
  private state: 'starting' | 'active' | 'closing' = 'starting'

  /**
   * Validate configuration and construct the official client.
   * @param ctx - owning Host context.
   * @param config - validated Elasticsearch target and transport settings.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'elasticsearch')
    this.ownerFiber = ctx.fiber
    this.client = new Client(resolveClientOptions(config))
    this.startupPingTimeoutMs = config.pingTimeoutMs
  }

  /** Verify startup connectivity without retries and bind teardown to the service fiber. */
  async [Service.init](): Promise<void> {
    this.ctx.effect(() => async () => this.close(), 'elasticsearch.client')
    await this.trackOperation(async (client) => {
      const available = await client.ping({}, {
        requestTimeout: this.startupPingTimeoutMs,
        maxRetries: 0,
        signal: AbortSignal.timeout(this.startupPingTimeoutMs),
      })
      if (!available) throw new Error('elasticsearch: startup ping failed')
    })
    this.state = 'active'
  }

  /**
   * Run one callback with the shared official client. Admission precedes the
   * callback, so disposal waits for every callback already accepted.
   * The borrowed API makes direct lifecycle controls, transport internals, and
   * client metadata unavailable. The callback must not retain it after
   * settlement. It must await client-backed requests and fully consume or close
   * client-backed streams and iterators before its result settles. Materialized
   * response values may be returned.
   * @param callback - Elasticsearch work using the callback-scoped client.
   * @returns the callback result.
   * @throws before activation, while the service is closing, or when the callback rejects.
   */
  async operation<T>(callback: (client: ElasticsearchClient) => T | Promise<T>): Promise<T> {
    const fiberState = this.ownerFiber.state
    if (
      this.state === 'closing'
      || fiberState === FiberState.UNLOADING
      || fiberState === FiberState.DISPOSED
    ) {
      throw new Error('elasticsearch service is closing or closed')
    }
    if (this.state === 'starting' || fiberState !== FiberState.ACTIVE) {
      throw new Error('elasticsearch service is not active')
    }
    return this.trackOperation(callback)
  }

  /** Track one admitted callback so teardown can await its settlement. */
  private async trackOperation<T>(callback: (client: ElasticsearchClient) => T | Promise<T>): Promise<T> {
    const operation = Promise.withResolvers<undefined>()
    this.operations.add(operation.promise)
    try {
      // The service retains ownership while the callback sees only its borrowed API.
      return await callback(this.client as unknown as ElasticsearchClient)
    } finally {
      this.operations.delete(operation.promise)
      operation.resolve(undefined)
    }
  }

  /** Stop admission, drain every admitted callback, then close the client. */
  private async close(): Promise<void> {
    this.state = 'closing'
    await Promise.all([...this.operations])
    await this.client.close()
  }
}

export default ElasticsearchService
