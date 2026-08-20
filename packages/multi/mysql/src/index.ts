/**
 * Host-only MySQL connection service. It owns one connection pool, verifies
 * connectivity during startup, leases connections only for callbacks, and
 * drains admitted callbacks before closing the pool.
 * @module @deepseek-ai/dsh-mysql
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { createPool } from 'mysql2/promise'
import type { Pool, PoolConnection } from 'mysql2/promise'

const DEFAULT_MYSQL_PORT = 3306
const DEFAULT_CONNECTION_LIMIT = 10
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

const BLOCKED_CONNECTION_MEMBERS: ReadonlySet<PropertyKey> = new Set([
  'changeUser',
  'connect',
  'connection',
  'destroy',
  'end',
  'pause',
  'release',
  'reset',
  'resume',
  Symbol.asyncDispose,
])

const BLOCKED_TRANSACTION_MEMBERS: ReadonlySet<PropertyKey> = new Set([
  'beginTransaction',
  'commit',
  'rollback',
])

type BlockedConnectionMember =
  | 'changeUser'
  | 'connect'
  | 'connection'
  | 'destroy'
  | 'end'
  | 'pause'
  | 'release'
  | 'reset'
  | 'resume'
  | typeof Symbol.asyncDispose

type BlockedTransactionMember = 'beginTransaction' | 'commit' | 'rollback'

/**
 * Callback-scoped MySQL driver connection. Pool lifecycle methods and the raw
 * connection are unavailable, and every operation fails after callback settlement.
 */
export type MysqlConnection = Omit<PoolConnection, BlockedConnectionMember>

/** Callback-scoped connection inside a transaction. Transaction lifecycle is owned by the service. */
export type MysqlTransactionConnection = Omit<MysqlConnection, BlockedTransactionMember>

interface ConnectionLease {
  connection: MysqlConnection
  expire(): void
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function createConnectionLease(
  connection: PoolConnection,
  blockedMembers: ReadonlySet<PropertyKey> = BLOCKED_CONNECTION_MEMBERS,
): ConnectionLease {
  let active = true
  const assertActive = (): void => {
    if (!active) throw new Error('mysql connection lease has settled')
  }
  const wrap = <T extends object>(value: T): T => new Proxy({}, {
    get(_target, prop): unknown {
      assertActive()
      if (blockedMembers.has(prop)) {
        throw new Error(`mysql connection lease does not expose "${String(prop)}"`)
      }
      const member = Reflect.get(value, prop, value) as unknown
      if (typeof member === 'function') {
        return (...args: unknown[]): unknown => {
          assertActive()
          const result = Reflect.apply(member, value, args) as unknown
          if (prop === 'prepare') {
            return Promise.resolve(result as PromiseLike<object>).then(statement => wrap(statement))
          }
          return result
        }
      }
      if (typeof member === 'object' && member !== null) {
        throw new Error(`mysql connection lease does not expose object member "${String(prop)}"`)
      }
      return member
    },
    set(_target, prop): boolean {
      throw new Error(`mysql connection lease is read-only; cannot assign "${String(prop)}"`)
    },
  }) as T
  return {
    connection: wrap(connection),
    expire() {
      active = false
    },
  }
}

/** MySQL connection service configuration. */
export interface Config {
  /** MySQL server hostname or IP address. */
  host: string
  /** MySQL TCP port; defaults to `3306`. */
  port?: number
  /** Bootstrap database user. */
  user: string
  /** Bootstrap database password; Schemastery treats this field as a secret. */
  password: string
  /** Database selected for every pooled connection. */
  database: string
  /** Maximum number of connections in the pool; defaults to `10`. */
  connectionLimit?: number
  /** TCP connection-establishment timeout in milliseconds; at most `MAX_TIMER_DELAY_MS`. */
  connectTimeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mysql: Mysql
  }
}

/**
 * MySQL pool service exposed as `ctx.mysql`. Startup acquires one connection
 * and pings the server; failure rejects plugin activation. {@link connection}
 * admits work only while the service is active and resets every reusable lease.
 */
export class Mysql extends Service {
  static Config: z<Config> = z.object({
    host: z.string().min(1).required(),
    port: z.natural().min(1).max(65_535).default(DEFAULT_MYSQL_PORT),
    user: z.string().min(1).required(),
    password: z.string().role('secret').required(),
    database: z.string().min(1).required(),
    connectionLimit: z.natural().min(1).default(DEFAULT_CONNECTION_LIMIT),
    connectTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CONNECT_TIMEOUT_MS),
  })

  private readonly pool: Pool
  private readonly database: string
  private readonly leases = new Set<Promise<void>>()
  private accepting = true

  /**
   * Create the lazily connecting pool. Cordis validates and defaults the
   * configuration before constructing the service.
   * @param ctx - owning Host context.
   * @param config - validated MySQL target and pool settings.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mysql')
    const resolved = config as Required<Config>
    this.database = resolved.database
    this.pool = createPool({
      host: resolved.host,
      port: resolved.port,
      user: resolved.user,
      password: resolved.password,
      database: resolved.database,
      connectionLimit: resolved.connectionLimit,
      connectTimeout: resolved.connectTimeoutMs,
    })
  }

  /** Verify startup connectivity and bind pool teardown to the service fiber. */
  async [Service.init](): Promise<void> {
    this.ctx.effect(() => async () => this.close(), 'mysql.pool')
    await this.connection(async (connection) => {
      await connection.ping()
    })
  }

  /**
   * Lease one pooled connection for a callback. Admission precedes pool
   * acquisition, so disposal waits for callbacks already queued for a lease.
   * The connection is reset, restored to the configured database, and released
   * after callback settlement, including throws. Failed cleanup destroys it.
   * The callback receives a façade without pool lifecycle methods or raw driver
   * state. The façade and prepared statements obtained from it cannot be
   * returned and reject every operation after callback settlement.
   * @param callback - database work scoped to this connection lease.
   * @returns the callback result.
   * @throws when the service is closing, pool acquisition fails, or the callback rejects.
   */
  async connection<T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> {
    if (!this.accepting) {
      throw new Error('mysql connection service is closing or closed')
    }

    const completion = deferred<void>()
    this.leases.add(completion.promise)
    let connection: PoolConnection | undefined
    let connectionLease: ConnectionLease | undefined
    try {
      connection = await this.pool.getConnection()
      connectionLease = createConnectionLease(connection)
      return await callback(connectionLease.connection)
    } finally {
      try {
        connectionLease?.expire()
        if (connection) await this.resetOrDestroy(connection)
      } finally {
        this.leases.delete(completion.promise)
        completion.resolve(undefined)
      }
    }
  }

  /**
   * Run one callback in a transaction owned by this service. The callback
   * receives a query-only façade; begin, commit and rollback are performed by
   * the service and the leased connection expires after settlement.
   * @param callback - database work that must commit or roll back as one unit.
   * @returns the callback result after the commit is acknowledged.
   * @throws the callback error, rollback error, or commit error.
   */
  async transaction<T>(callback: (connection: MysqlTransactionConnection) => T | Promise<T>): Promise<T> {
    return this.connection(async (connection) => {
      await connection.beginTransaction()
      const transactionLease = createConnectionLease(
        connection as unknown as PoolConnection,
        new Set([...BLOCKED_CONNECTION_MEMBERS, ...BLOCKED_TRANSACTION_MEMBERS]),
      )
      try {
        const result = await callback(transactionLease.connection as MysqlTransactionConnection)
        await connection.commit()
        return result
      } catch (error: unknown) {
        try {
          await connection.rollback()
        } catch {
          // Preserve the callback or commit failure; connection cleanup still
          // runs in the outer lease and destroys an uncertain connection.
        }
        throw error
      } finally {
        transactionLease.expire()
      }
    })
  }

  private async resetOrDestroy(connection: PoolConnection): Promise<void> {
    try {
      await this.resetSession(connection)
    } catch {
      // Failed cleanup leaves unknown server session state; preserve the callback outcome.
      connection.destroy()
      return
    }
    connection.release()
  }

  private async resetSession(connection: PoolConnection): Promise<void> {
    await connection.reset()
    await connection.query('USE ??', [this.database])
  }

  /** Stop admission, drain every admitted callback, then release the pool. */
  private async close(): Promise<void> {
    this.accepting = false
    await Promise.all([...this.leases])
    await this.pool.end()
  }
}

export default Mysql
