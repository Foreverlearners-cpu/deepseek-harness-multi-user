/**
 * MySQL row-based change capture with bounded, at-least-once Kafka delivery.
 * @module @deepseek-ai/dsh-cdc
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { KafkaError, KafkaTopic } from '@deepseek-ai/dsh-kafka'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import ZongJi from '@vlasky/zongji'
import type {
  AnyBinlogEvent,
  BinlogEventByName,
  BinlogEventName,
  DeleteRowsEvent,
  TableMapEntry,
  UpdateRowsEvent,
  WriteRowsEvent,
} from '@vlasky/zongji'
import { createConnection } from 'mysql2/promise'
import { encodeCdcEvent, encodeKey, digest, findChangedColumns, normalizeRow } from './codec.ts'
import { readCheckpoint, writeCheckpoint } from './checkpoint.ts'
import type { CdcCheckpoint, CdcEvent, CdcOperation, CdcValue } from './types.ts'

export {
  decodeCdcEvent,
  digest,
  encodeCdcEvent,
  encodeKey,
  findChangedColumns,
  getChangedColumns,
  normalizeRow,
} from './codec.ts'
export type { CdcCheckpoint, CdcEvent, CdcOperation, CdcSource, CdcValue } from './types.ts'

const DEFAULT_MYSQL_PORT = 3306
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_EVENT_BYTES = 1_048_576
const DEFAULT_MAX_BINLOG_EVENT_BYTES = 67_108_864
const DEFAULT_MAX_QUEUE_BYTES = 16_777_216
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000

class CdcConfigurationError extends Error {}
class CdcRecoverableError extends Error {}
class CdcShutdownError extends Error {}

/** A bounded MySQL/reader operation that can be retried by the existing policy. */
class CdcTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'

  constructor(operation: string, timeoutMs: number) {
    super(`cdc: ${operation} timed out after ${timeoutMs}ms`)
  }
}

/**
 * Bound an operation whose underlying driver does not accept an AbortSignal.
 * The promise is observed after the race so a late driver rejection cannot
 * become an unhandled rejection. The timeout callback is deliberately best
 * effort: the timeout remains the authoritative failure.
 */
function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  name: string,
  onTimeout?: () => void,
): Promise<T> {
  const pending = Promise.resolve().then(operation)
  void pending.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {
        // Driver teardown is best effort; preserve the deadline error.
      }
      reject(new CdcTimeoutError(name, timeoutMs))
    }, timeoutMs)
  })
  return Promise.race([pending, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function destroyMysqlConnection(connection: { destroy(): void }): void {
  try {
    connection.destroy()
  } catch {
    // A connection can already be destroyed by the driver's timeout path.
  }
}

/** One source table and its Kafka routing and identity policy. */
export interface CdcTableRoute {
  /** Source schema name. */
  database: string
  /** Source table name. */
  table: string
  /** Kafka destination topic. */
  topic: string
  /** Ordered source primary-key columns. */
  primaryKey: string[]
  /** Columns removed before publication. */
  excludeColumns?: string[]
}

/** MySQL CDC producer configuration. */
export interface Config {
  /** MySQL hostname. */
  host: string
  /** MySQL port. */
  port?: number
  /** Replication username. */
  user: string
  /** Replication password. */
  password: string
  /** Unique replication server id. */
  serverId: number
  /** MySQL connection timeout. */
  connectTimeoutMs?: number
  /** Atomic local checkpoint path. */
  checkpointFile: string
  /** Routed source tables. */
  routes: CdcTableRoute[]
  /** Maximum serialized event size. */
  maxEventBytes?: number
  /** Maximum decoded MySQL RowsEvent size accepted for queued processing. */
  maxBinlogEventBytes?: number
  /** Approximate retained binlog bytes that trigger reader backpressure. */
  maxQueueBytes?: number
  /** First delay after a recoverable MySQL or Kafka failure. */
  retryInitialDelayMs?: number
  /** Maximum retry delay after repeated recoverable failures. */
  retryMaxDelayMs?: number
  /** Retries per failure burst; `unlimited` keeps retrying until disposal. */
  maxRetries?: number | 'unlimited'
}

/** Observable producer lifecycle state. */
export type CdcStatus =
  | 'starting'
  | 'streaming'
  | 'backpressured'
  | 'retrying'
  | 'paused-schema'
  | 'failed'
  | 'stopped'

interface ResolvedConfig extends Config {
  port: number
  connectTimeoutMs: number
  maxEventBytes: number
  maxBinlogEventBytes: number
  maxQueueBytes: number
  retryInitialDelayMs: number
  retryMaxDelayMs: number
  maxRetries: number | 'unlimited'
}

interface ResolvedRoute extends CdcTableRoute {
  excluded: ReadonlySet<string>
}

interface Variables {
  logBin: string | number
  binlogFormat: string
  binlogRowImage: string
  binlogRowMetadata: string
  binlogTransactionCompression: string | number
  binlogRowValueOptions: string
}

interface MetadataColumnRow {
  databaseName: unknown
  tableName: unknown
  columnName: unknown
}

interface MetadataNameRow {
  columnName: unknown
}

interface BinlogStatusRow {
  Log_name?: unknown
  File_size?: unknown
}

interface BinlogTail {
  file: string
  position: number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

type RowsWithBitmaps = (WriteRowsEvent | UpdateRowsEvent | DeleteRowsEvent) & {
  columns_present_bitmap?: Uint8Array
  columns_present_bitmap2?: Uint8Array
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    cdc: CdcService
  }
}

function eventIs<Name extends BinlogEventName>(
  event: AnyBinlogEvent,
  name: Name,
): event is BinlogEventByName<Name> {
  return event.getEventName() === name
}

function routeId(database: string, table: string): string {
  return `${database}.${table}`
}

function resolveRoutes(routes: readonly CdcTableRoute[]): Map<string, ResolvedRoute> {
  if (routes.length === 0) throw new Error('cdc: at least one table route is required')
  const output = new Map<string, ResolvedRoute>()
  for (const route of routes) {
    const id = routeId(route.database, route.table)
    const excludedColumns = route.excludeColumns ?? []
    const excluded = new Set(excludedColumns)
    if (
      route.database.trim().length === 0 || route.table.trim().length === 0
      || route.topic.trim().length === 0 || route.primaryKey.length === 0
      || new Set(route.primaryKey).size !== route.primaryKey.length
      || excluded.size !== excludedColumns.length
      || excludedColumns.some(column => column.trim().length === 0)
      || route.primaryKey.some(column => column.trim().length === 0 || excluded.has(column))
      || output.has(id)
    ) throw new Error(`cdc: invalid or duplicate route ${JSON.stringify(id)}`)
    output.set(id, { ...route, excluded })
  }
  return output
}

function schemaFingerprint(table: TableMapEntry, route: ResolvedRoute): string {
  const columns = table.columnSchemas.map(column => ({
    name: column.COLUMN_NAME,
    type: column.COLUMN_TYPE,
    unsigned: column.UNSIGNED ?? false,
    characterSet: column.CHARACTER_SET_NAME ?? null,
    collation: column.COLLATION_NAME ?? null,
    enumValues: column.ENUM_VALUES ?? null,
    setValues: column.SET_VALUES ?? null,
  }))
  for (const key of route.primaryKey) {
    if (!columns.some(column => column.name === key)) {
      throw new Error(`cdc: primary key column ${JSON.stringify(key)} is absent from ${routeId(route.database, route.table)}`)
    }
  }
  return digest(JSON.stringify({ columns, primaryKey: route.primaryKey }))
}

function allColumnsPresent(bitmap: Uint8Array | undefined, count: number): boolean {
  if (bitmap === undefined || bitmap.byteLength !== Math.ceil(count / 8)) return false
  for (let index = 0; index < count; index += 1) {
    const byte = bitmap[Math.floor(index / 8)]
    if (byte === undefined || (byte & (1 << (index % 8))) === 0) return false
  }
  return true
}

interface SqlToken {
  value: string
  punctuation: boolean
}

function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let index = 0
  while (index < sql.length) {
    const character = sql.charAt(index)
    if (/\s/u.test(character) || character === ';') {
      index += 1
      continue
    }
    if (character === '#' || (character === '-' && sql[index + 1] === '-')) {
      const newline = sql.indexOf('\n', index + 1)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }
    if (character === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      const mysqlExecutable = sql[index + 2] === '!'
      const mariaExecutable = sql.slice(index + 2, index + 4).toUpperCase() === 'M!'
      if (end !== -1 && (mysqlExecutable || mariaExecutable)) {
        let content = index + (mariaExecutable ? 4 : 3)
        while (/\d/u.test(sql.charAt(content))) content += 1
        tokens.push(...sqlTokens(sql.slice(content, end)))
      }
      index = end === -1 ? sql.length : end + 2
      continue
    }
    if (character === '`' || character === '"') {
      const delimiter = character
      let value = ''
      index += 1
      while (index < sql.length) {
        if (sql[index] === delimiter) {
          if (sql[index + 1] === delimiter) {
            value += delimiter
            index += 2
            continue
          }
          index += 1
          break
        }
        value += sql.charAt(index)
        index += 1
      }
      tokens.push({ value, punctuation: false })
      continue
    }
    if (character === "'") {
      index += 1
      while (index < sql.length) {
        if (sql[index] === '\\') {
          index += 2
          continue
        }
        if (sql[index] === "'") {
          index += sql[index + 1] === "'" ? 2 : 1
          if (sql[index - 1] === "'" && sql[index - 2] !== "'") break
          continue
        }
        index += 1
      }
      tokens.push({ value: '', punctuation: false })
      continue
    }
    if (['.', ',', '(', ')'].includes(character)) {
      tokens.push({ value: character, punctuation: true })
      index += 1
      continue
    }
    const start = index
    while (
      index < sql.length
      && !/[\s;.,()'"`#]/u.test(sql.charAt(index))
      && !(sql[index] === '/' && sql[index + 1] === '*')
      && !(sql[index] === '-' && sql[index + 1] === '-')
    ) index += 1
    if (index === start) index += 1
    else tokens.push({ value: sql.slice(start, index), punctuation: false })
  }
  return tokens
}

function keyword(token: SqlToken | undefined): string {
  return token?.punctuation === false ? token.value.toUpperCase() : ''
}

function truncateTarget(query: BinlogEventByName<'query'>): string | undefined {
  const tokens = sqlTokens(query.query)
  if (keyword(tokens[0]) !== 'TRUNCATE') return undefined
  let index = keyword(tokens[1]) === 'TABLE' ? 2 : 1
  const first = tokens[index]
  if (first === undefined || first.punctuation || first.value.length === 0) return ''
  index += 1
  if (tokens[index]?.value !== '.') {
    return query.schema.length === 0 ? '' : routeId(query.schema, first.value)
  }
  const table = tokens[index + 1]
  if (table === undefined || table.punctuation || table.value.length === 0) return ''
  return routeId(first.value, table.value)
}

function unsafeStatementQuery(query: string): boolean {
  const tokens = sqlTokens(query)
  const first = keyword(tokens[0])
  return ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'LOAD', 'WITH', 'CALL'].includes(first)
}

function schemaChangingQuery(query: string): boolean {
  const tokens = sqlTokens(query)
  const first = keyword(tokens[0])
  if (first === 'ALTER') {
    const modifiers = new Set(['ONLINE', 'OFFLINE', 'IGNORE'])
    let index = 1
    while (modifiers.has(keyword(tokens[index]))) index += 1
    return ['TABLE', 'DATABASE', 'SCHEMA'].includes(keyword(tokens[index]))
  }
  if (first === 'RENAME') return keyword(tokens[1]) === 'TABLE'
  if (first !== 'CREATE' && first !== 'DROP') return false

  const modifiers = first === 'CREATE'
    ? new Set(['OR', 'REPLACE', 'TEMPORARY', 'UNIQUE', 'FULLTEXT', 'SPATIAL'])
    : new Set(['TEMPORARY'])
  let index = 1
  while (modifiers.has(keyword(tokens[index]))) index += 1
  return ['TABLE', 'DATABASE', 'SCHEMA', 'INDEX'].includes(keyword(tokens[index]))
}

function xaQuery(query: string): boolean {
  return keyword(sqlTokens(query)[0]) === 'XA'
}

function retryDelay(config: ResolvedConfig, failures: number): number {
  return Math.min(
    config.retryMaxDelayMs,
    config.retryInitialDelayMs * 2 ** Math.min(failures - 1, 30),
  )
}

function canRetry(config: ResolvedConfig, failures: number): boolean {
  return config.maxRetries === 'unlimited' || failures <= config.maxRetries
}

function errorCode(cause: unknown): string | number | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined
  const code: unknown = cause.code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function recoverableMysqlError(cause: unknown): boolean {
  return new Set<string | number>([
    'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN',
    'ER_TOO_MANY_USER_CONNECTIONS', 1040, 1053,
  ]).has(errorCode(cause) ?? '')
}

function recoverableKafkaError(cause: unknown): boolean {
  return cause instanceof KafkaError
    && ['timeout', 'unavailable', 'unknown'].includes(cause.code)
}

function rowKey(row: Record<string, CdcValue>, route: ResolvedRoute): Record<string, CdcValue> {
  const key: Record<string, CdcValue> = {}
  for (const column of route.primaryKey) {
    const value = row[column]
    if (value === undefined || value === null) {
      throw new Error(`cdc: row has no non-null primary key ${JSON.stringify(column)}`)
    }
    key[column] = value
  }
  return key
}

function excludedImage(
  row: Record<string, CdcValue>,
  excluded: ReadonlySet<string>,
): Record<string, CdcValue> {
  return Object.fromEntries(Object.entries(row).filter(([column]) => !excluded.has(column)))
}

function mysqlEnabled(value: string | number): boolean {
  return value === 1 || String(value).toUpperCase() === 'ON'
}

async function validateMysql(config: ResolvedConfig): Promise<BinlogTail> {
  const connection = await createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    connectTimeout: config.connectTimeoutMs,
  })
  const query = (sql: string, values?: string[]) => withDeadline(
    () => values === undefined
      ? connection.query(sql)
      : connection.query(sql, values),
    config.connectTimeoutMs,
    'MySQL metadata query',
    () => { destroyMysqlConnection(connection) },
  )
  let result: BinlogTail | undefined
  let validationError: unknown
  try {
    const [rows] = await query(`
      SELECT
        @@GLOBAL.log_bin AS logBin,
        @@GLOBAL.binlog_format AS binlogFormat,
        @@GLOBAL.binlog_row_image AS binlogRowImage,
        @@GLOBAL.binlog_row_metadata AS binlogRowMetadata,
        @@GLOBAL.binlog_transaction_compression AS binlogTransactionCompression,
        @@GLOBAL.binlog_row_value_options AS binlogRowValueOptions
    `)
    const variables = (rows as Variables[])[0]
    if (
      variables === undefined || !mysqlEnabled(variables.logBin)
      || variables.binlogFormat.toUpperCase() !== 'ROW'
      || variables.binlogRowImage.toUpperCase() !== 'FULL'
      || variables.binlogRowMetadata.toUpperCase() !== 'FULL'
      || mysqlEnabled(variables.binlogTransactionCompression)
      || variables.binlogRowValueOptions.trim().length > 0
    ) {
      throw new CdcConfigurationError('cdc: MySQL requires log_bin=ON, ROW/FULL/FULL binlog settings, transaction compression OFF, and empty binlog_row_value_options')
    }
    for (const route of config.routes) {
      const [columnRows] = await query(`
        SELECT
          TABLE_SCHEMA AS databaseName,
          TABLE_NAME AS tableName,
          COLUMN_NAME AS columnName
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [route.database, route.table])
      const metadata = columnRows as MetadataColumnRow[]
      const columns = metadata.map(row => row.columnName)
      if (
        metadata.length === 0
        || metadata.some(row => (
          row.databaseName !== route.database || row.tableName !== route.table
          || typeof row.columnName !== 'string'
        ))
      ) {
        throw new CdcConfigurationError(
          `cdc: routed table ${routeId(route.database, route.table)} is unavailable`,
        )
      }
      for (const column of [...route.primaryKey, ...route.excludeColumns ?? []]) {
        if (!columns.includes(column)) {
          throw new CdcConfigurationError(
            `cdc: configured column ${JSON.stringify(column)} is absent from ${routeId(route.database, route.table)}`,
          )
        }
      }
      const [primaryRows] = await query(`
        SELECT COLUMN_NAME AS columnName
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX
      `, [route.database, route.table])
      const primaryKey = (primaryRows as MetadataNameRow[]).map(row => row.columnName)
      if (
        primaryKey.some(column => typeof column !== 'string')
        || JSON.stringify(primaryKey) !== JSON.stringify(route.primaryKey)
      ) {
        throw new CdcConfigurationError(
          `cdc: configured primary key does not match MySQL metadata for ${routeId(route.database, route.table)}`,
        )
      }
    }

    const [binlogRows] = await query('SHOW BINARY LOGS')
    const tail = (binlogRows as BinlogStatusRow[]).at(-1)
    const file = tail?.Log_name
    const position = Number(tail?.File_size)
    if (
      typeof file !== 'string' || file.length === 0
      || !Number.isSafeInteger(position) || position < 4
    ) {
      throw new CdcConfigurationError('cdc: MySQL did not report a valid binary log tail')
    }
    result = { file, position }
  } catch (cause) {
    validationError = cause
  }
  let closeError: unknown
  try {
    await withDeadline(
      () => connection.end(),
      config.connectTimeoutMs,
      'MySQL connection close',
      () => { destroyMysqlConnection(connection) },
    )
  } catch (cause) {
    closeError = cause
  }
  if (validationError !== undefined) {
    if (closeError === undefined) throw validationError
    const aggregate = new AggregateError([validationError, closeError])
    if (validationError instanceof CdcConfigurationError) {
      throw new CdcConfigurationError('cdc: MySQL validation failed while closing the connection', {
        cause: aggregate,
      })
    }
    if (validationError instanceof CdcRecoverableError || recoverableMysqlError(validationError)
      || recoverableMysqlError(closeError)) {
      throw new CdcRecoverableError('cdc: MySQL validation failed while closing the connection', {
        cause: aggregate,
      })
    }
    throw new Error('cdc: MySQL validation failed while closing the connection', { cause: aggregate })
  }
  if (closeError !== undefined) throw closeError
  if (result === undefined) throw new Error('cdc: MySQL validation did not produce a binary log tail')
  return result
}

/** Captures configured MySQL row changes and publishes them to Kafka. */
export class CdcService extends Service {
  static inject = ['kafka']
  static Config: z<Config> = z.object({
    host: z.string().min(1).required(),
    port: z.natural().min(1).max(65_535).default(DEFAULT_MYSQL_PORT),
    user: z.string().min(1).required(),
    password: z.string().role('secret').required(),
    serverId: z.natural().min(1).max(4_294_967_295).required(),
    connectTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CONNECT_TIMEOUT_MS),
    checkpointFile: z.string().min(1).required(),
    routes: z.array(z.object({
      database: z.string().min(1).required(),
      table: z.string().min(1).required(),
      topic: z.string().min(1).required(),
      primaryKey: z.array(z.string().min(1)).required(),
      excludeColumns: z.array(z.string().min(1)).default([]),
    })).required(),
    maxEventBytes: z.natural().min(1).default(DEFAULT_MAX_EVENT_BYTES),
    maxBinlogEventBytes: z.natural().min(1).default(DEFAULT_MAX_BINLOG_EVENT_BYTES),
    maxQueueBytes: z.natural().min(1).default(DEFAULT_MAX_QUEUE_BYTES),
    retryInitialDelayMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_INITIAL_DELAY_MS),
    retryMaxDelayMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_MAX_DELAY_MS),
    maxRetries: z.union([
      z.natural().max(Number.MAX_SAFE_INTEGER), z.const('unlimited'),
    ] as const).default('unlimited'),
  })

  private readonly config: ResolvedConfig
  private readonly routes: ReadonlyMap<string, ResolvedRoute>
  private readonly reader: ZongJi
  private readonly observedSchemas = new Map<string, string>()
  private readonly completion = Promise.withResolvers<void>()
  private readonly shutdown = new AbortController()
  private checkpoint: CdcCheckpoint | undefined
  private currentFile = ''
  private queuedBytes = 0
  private tail = Promise.resolve()
  /** Monotonic admission sequence used to drain work accepted before a terminal event. */
  private queueSequence = 0
  private terminalFailureSequence?: number
  private queueFailureSequence?: number
  private terminalFailure?: Error
  private state: CdcStatus = 'starting'
  private stopping = false
  private completionSettled = false
  private expectedStops = 0
  private readerStart: Deferred<void> | undefined
  private recovery: Promise<void> | undefined
  private stopOperation: Promise<void> | undefined
  private closeOperation?: Promise<void>
  private queueFailure: Error | undefined
  private terminalQuiescence: Promise<void> | undefined
  private readerAccepting = false
  /** Ignore one late stopped event after a bounded stop timed out. */
  private ignoreStoppedBeforeReady = false

  /** Resolves after disposal and rejects if capture terminates unexpectedly. */
  readonly done: Promise<void> = this.completion.promise

  /** Current capture lifecycle state for Host health reporting. */
  get status(): CdcStatus {
    return this.state
  }

  /** Terminal failure, when `status` is `failed` or `paused-schema`. */
  get lastError(): Error | undefined {
    return this.terminalFailure
  }

  /** Create one dedicated replication reader owned by this Cordis service. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'cdc')
    this.config = config as ResolvedConfig
    this.routes = resolveRoutes(config.routes)
    if (this.config.maxQueueBytes < this.config.maxEventBytes) {
      throw new Error('cdc: maxQueueBytes must be at least maxEventBytes')
    }
    if (this.config.retryInitialDelayMs > this.config.retryMaxDelayMs) {
      throw new Error('cdc: retryInitialDelayMs must not exceed retryMaxDelayMs')
    }
    this.reader = new ZongJi({
      host: config.host,
      port: this.config.port,
      user: config.user,
      password: config.password,
      connectTimeout: this.config.connectTimeoutMs,
      dateStrings: true,
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
    })
    this.reader.on('ready', () => {
      this.onReaderReady()
    })
    this.reader.on('error', (error) => { this.onReaderError(error) })
    this.reader.on('stopped', () => { this.onReaderStopped() })
    this.reader.on('binlog', (event) => { this.onBinlog(event) })
    void this.done.catch(() => {})
  }

  /** Validate MySQL, restore the checkpoint, and wait for replication readiness. */
  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => async () => this.close(), 'cdc.reader')
    try {
      this.checkpoint = await readCheckpoint(this.config.checkpointFile)
      this.currentFile = this.checkpoint?.file ?? ''
      for (const id of this.routes.keys()) {
        const fingerprint = this.checkpoint?.schemas[id]
        if (fingerprint !== undefined) this.observedSchemas.set(id, fingerprint)
      }
      await this.startInitialReader()
    } catch (cause) {
      const error = cause instanceof Error
        ? cause
        : new Error('cdc: initialization failed', { cause })
      this.terminate(error)
      await this.stopReader()
      throw error
    }
  }

  private async startInitialReader(): Promise<void> {
    for (let failures = 0; ; ) {
      try {
        const tail = await validateMysql(this.config)
        if (this.checkpoint === undefined) {
          const checkpoint: CdcCheckpoint = {
            version: 1,
            file: tail.file,
            position: tail.position,
            schemas: Object.fromEntries(this.observedSchemas),
          }
          await writeCheckpoint(this.config.checkpointFile, checkpoint)
          this.checkpoint = checkpoint
          this.currentFile = checkpoint.file
        }
        await this.startReader()
        return
      } catch (cause) {
        if (this.stopping || this.shutdown.signal.aborted) {
          throw new CdcShutdownError('cdc: MySQL startup stopped', { cause })
        }
        if (
          cause instanceof CdcConfigurationError
          || (!(cause instanceof CdcRecoverableError) && !recoverableMysqlError(cause))
        ) throw cause
        try {
          await this.stopReader()
        } catch (stopCause) {
          throw new Error('cdc: MySQL startup cleanup failed', {
            cause: new AggregateError([cause, stopCause]),
          })
        }
        failures += 1
        if (!canRetry(this.config, failures)) {
          throw new Error('cdc: MySQL startup retries exhausted', { cause })
        }
        this.state = 'retrying'
        const delayMs = retryDelay(this.config, failures)
        this.ctx.logger.warn(`cdc: MySQL startup failed; retrying in ${delayMs}ms`)
        if (!await this.waitForRetry(delayMs)) {
          throw new CdcShutdownError('cdc: MySQL startup retry stopped', { cause })
        }
      }
    }
  }

  private async startReader(): Promise<void> {
    const checkpoint = this.checkpoint
    if (checkpoint === undefined) {
      throw new Error('cdc: replication reader requires an initial checkpoint')
    }
    const readiness = Promise.withResolvers<void>()
    this.readerAccepting = false
    this.readerStart = readiness
    const includeSchema: Record<string, string[]> = {}
    for (const route of this.routes.values()) {
      const tables = includeSchema[route.database] ?? []
      tables.push(route.table)
      includeSchema[route.database] = tables
    }
    try {
      this.reader.start({
        serverId: this.config.serverId,
        startAtEnd: false,
        filename: checkpoint.file,
        position: checkpoint.position,
        includeSchema,
        includeEvents: [
          'rotate', 'tablemap', 'writerows', 'updaterows', 'deleterows', 'xid',
          'query', 'xaprepare', 'transactionpayload', 'partialupdaterows', 'unknown',
        ],
      })
      await withDeadline(
        () => readiness.promise,
        this.config.connectTimeoutMs,
        'replication reader readiness',
      )
    } catch (cause) {
      try {
        await this.stopReader()
      } catch (stopCause) {
        const aggregate = new AggregateError([cause, stopCause])
        if (cause instanceof CdcRecoverableError || recoverableMysqlError(cause)) {
          throw new CdcRecoverableError('cdc: replication reader startup cleanup failed', {
            cause: aggregate,
          })
        }
        throw new Error('cdc: replication reader startup cleanup failed', { cause: aggregate })
      }
      throw cause
    } finally {
      if (this.readerStart === readiness) this.readerStart = undefined
    }
  }

  private onReaderReady(): void {
    const readiness = this.readerStart
    if (readiness === undefined) return
    this.ignoreStoppedBeforeReady = false
    try {
      const file = this.reader.options.filename ?? ''
      const position = this.reader.options.position
      if (file.length === 0 || position === undefined || position < 4) {
        throw new Error('cdc: replication reader did not report a valid binlog position')
      }
      this.currentFile = file
      if (
        this.readerStart !== readiness || this.stopping
        || this.terminalFailure !== undefined
      ) throw new CdcShutdownError('cdc: reader readiness was superseded')
      this.readerStart = undefined
      this.readerAccepting = true
      this.state = 'streaming'
      readiness.resolve()
    } catch (cause) {
      if (this.readerStart === readiness) this.readerStart = undefined
      readiness.reject(cause)
    }
  }

  private onReaderError(cause: Error): void {
    if (this.stopping || this.terminalFailure !== undefined) return
    this.readerAccepting = false
    const readiness = this.readerStart
    if (readiness !== undefined) {
      this.readerStart = undefined
      readiness.reject(cause)
      return
    }
    if (recoverableMysqlError(cause)) {
      this.scheduleRecovery(new CdcRecoverableError('cdc: MySQL replication connection failed', { cause }))
      return
    }
    this.terminate(new Error('cdc: MySQL replication reader failed', { cause }))
  }

  private onReaderStopped(): void {
    this.readerAccepting = false
    if (this.ignoreStoppedBeforeReady) {
      this.ignoreStoppedBeforeReady = false
      if (this.readerStart !== undefined) return
    }
    const readiness = this.readerStart
    if (readiness !== undefined) {
      this.readerStart = undefined
      readiness.reject(new CdcRecoverableError('cdc: replication reader stopped before readiness'))
    }
    if (this.expectedStops > 0) {
      this.expectedStops -= 1
      return
    }
    if (readiness !== undefined) return
    if (this.stopping || this.terminalFailure !== undefined) return
    this.scheduleRecovery(new CdcRecoverableError('cdc: replication reader stopped unexpectedly'))
  }

  private scheduleRecovery(error: Error): void {
    if (this.recovery !== undefined || this.stopping || this.terminalFailure !== undefined) return
    this.state = 'retrying'
    const recovery = this.recoverReader(error)
      .catch((cause: unknown) => {
        if (!this.stopping && this.terminalFailure === undefined) {
          this.terminate(new Error('cdc: MySQL recovery failed', { cause }))
        }
      })
      .finally(() => {
        if (this.recovery === recovery) this.recovery = undefined
      })
    this.recovery = recovery
  }

  private async recoverReader(initialError: Error): Promise<void> {
    let lastError = initialError
    await this.stopReader()
    await this.tail
    for (let failures = 1; !this.recoveryStopped(); failures += 1) {
      if (!canRetry(this.config, failures)) {
        this.terminate(new Error('cdc: MySQL recovery retries exhausted', { cause: lastError }))
        return
      }
      const delayMs = retryDelay(this.config, failures)
      this.ctx.logger.warn(`cdc: MySQL reader stopped; retrying in ${delayMs}ms`)
      if (!await this.waitForRetry(delayMs)) return
      if (this.recoveryStopped()) return
      try {
        await validateMysql(this.config)
        if (this.recoveryStopped()) return
        await this.startReader()
        return
      } catch (cause) {
        if (this.recoveryStopped()) return
        if (cause instanceof CdcConfigurationError) {
          this.terminate(cause)
          return
        }
        if (!(cause instanceof CdcRecoverableError) && !recoverableMysqlError(cause)) {
          this.terminate(new Error('cdc: MySQL reader restart failed', { cause }))
          return
        }
        lastError = cause instanceof Error
          ? cause
          : new CdcRecoverableError('cdc: MySQL reader restart failed', { cause })
        await this.stopReader()
        await this.tail
      }
    }
  }

  private recoveryStopped(): boolean {
    return this.shutdown.signal.aborted
  }

  private onBinlog(event: AnyBinlogEvent): void {
    if (this.stopping || this.terminalFailure !== undefined) return
    if (!this.readerAccepting) {
      this.terminate(new Error('cdc: received a binlog event before reader readiness'))
      return
    }
    try {
      if (eventIs(event, 'rotate')) {
        this.currentFile = event.binlogName
        this.enqueueCheckpoint(event.position)
        return
      }
      if (
        eventIs(event, 'transactionpayload') || eventIs(event, 'partialupdaterows')
        || eventIs(event, 'xaprepare') || eventIs(event, 'unknown')
      ) {
        throw new Error(`cdc: unsupported MySQL event ${event.getEventName()}`)
      }
      if (eventIs(event, 'tablemap')) this.validateTableMap(event)
      else if (eventIs(event, 'writerows')) this.enqueueRows(event, 'insert')
      else if (eventIs(event, 'updaterows')) this.enqueueRows(event, 'update')
      else if (eventIs(event, 'deleterows')) this.enqueueRows(event, 'delete')
      else if (eventIs(event, 'xid')) this.enqueueCheckpoint(event.nextPosition)
      else if (eventIs(event, 'query')) {
        if (xaQuery(event.query)) throw new Error('cdc: XA transactions are unsupported')
        if (unsafeStatementQuery(event.query)) {
          throw new Error('cdc: statement-based DML cannot be captured safely')
        }
        if (schemaChangingQuery(event.query)) {
          throw new Error('cdc: schema-changing DDL cannot be captured safely')
        }
        const target = truncateTarget(event)
        if (target !== undefined) {
          if (target.length === 0) throw new Error('cdc: TRUNCATE target could not be identified')
          if (this.routes.has(target)) {
            throw new Error(`cdc: TRUNCATE cannot be represented for routed table ${target}`)
          }
          this.enqueueCheckpoint(event.nextPosition)
        } else if (/^(?:COMMIT|ROLLBACK)$/iu.test(event.query.trim())) {
          this.enqueueCheckpoint(event.nextPosition)
        }
      }
    } catch (cause) {
      this.terminate(cause instanceof Error ? cause : new Error('cdc: binlog handler failed', { cause }))
    }
  }

  private validateTableMap(event: BinlogEventByName<'tablemap'>): void {
    const id = routeId(event.schemaName, event.tableName)
    const route = this.routes.get(id)
    if (route === undefined) throw new Error(`cdc: no route for received table ${id}`)
    if (!event.hasSelfDescribingMetadata() || event.columnNames === undefined || event.primaryKey === undefined) {
      throw new Error(`cdc: full primary-key metadata is unavailable for ${id}`)
    }
    const table = event.tableMap[event.tableId]
    if (
      table === undefined
      || JSON.stringify(table.columnSchemas.map(column => column.COLUMN_NAME))
        !== JSON.stringify(event.columnNames)
    ) throw new Error(`cdc: table metadata is inconsistent for ${id}`)
    const primaryKey = event.primaryKey.map(index => event.columnNames?.[index])
    if (
      primaryKey.some(column => column === undefined)
      || JSON.stringify(primaryKey) !== JSON.stringify(route.primaryKey)
    ) throw new Error(`cdc: configured primary key does not match MySQL metadata for ${id}`)
    for (const column of route.excluded) {
      if (!event.columnNames.includes(column)) {
        throw new Error(`cdc: excluded column ${JSON.stringify(column)} is absent from ${id}`)
      }
    }
    this.observeSchema(id, schemaFingerprint(table, route))
  }

  private enqueueRows(
    event: WriteRowsEvent | UpdateRowsEvent | DeleteRowsEvent,
    operation: CdcOperation,
  ): void {
    const table = event.tableMap[event.tableId]
    if (table === undefined) throw new Error('cdc: row event has no table metadata')
    const id = routeId(table.parentSchema, table.tableName)
    const route = this.routes.get(id)
    if (route === undefined) throw new Error(`cdc: no route for received table ${id}`)
    const fingerprint = schemaFingerprint(table, route)
    this.observeSchema(id, fingerprint)

    const bitmaps = event as RowsWithBitmaps
    if (
      event.numberOfColumns !== table.columnSchemas.length
      || !allColumnsPresent(bitmaps.columns_present_bitmap, event.numberOfColumns)
      || (eventIs(event, 'updaterows')
        && !allColumnsPresent(bitmaps.columns_present_bitmap2, event.numberOfColumns))
    ) {
      throw new Error(`cdc: incomplete row image for ${id}; binlog_row_image must remain FULL`)
    }
    if (!Number.isSafeInteger(event.size) || event.size < 1) {
      throw new Error(`cdc: invalid raw binlog event size for ${id}`)
    }
    if (event.size > this.config.maxBinlogEventBytes) {
      throw new Error(`cdc: raw binlog event exceeds maxBinlogEventBytes for ${id}`)
    }

    const file = this.currentFile
    const occurredAt = new Date(event.timestamp).toISOString()
    this.enqueue(Math.min(event.size, this.config.maxQueueBytes), async () => {
      for (let rowIndex = 0; rowIndex < event.rows.length; rowIndex += 1) {
        let before: Record<string, unknown> | null
        let after: Record<string, unknown> | null
        if (eventIs(event, 'updaterows')) {
          const eventRow = event.rows.at(rowIndex)
          if (eventRow === undefined) throw new Error(`cdc: row ${rowIndex} is unavailable for ${id}`)
          before = eventRow.before
          after = eventRow.after
        } else {
          const eventRow = event.rows.at(rowIndex)
          if (eventRow === undefined) throw new Error(`cdc: row ${rowIndex} is unavailable for ${id}`)
          before = operation === 'delete' ? eventRow : null
          after = operation === 'delete' ? null : eventRow
        }
        const normalizedBefore = before === null ? null : normalizeRow(before, new Set())
        const normalizedAfter = after === null ? null : normalizeRow(after, new Set())
        const normalizedIdentity = normalizedAfter ?? normalizedBefore
        if (normalizedIdentity === null) throw new Error(`cdc: row image is empty for ${id}`)
        const key = rowKey(normalizedIdentity, route)
        const previousKey = operation === 'update' && normalizedBefore !== null
          ? rowKey(normalizedBefore, route)
          : null
        if (previousKey !== null && JSON.stringify(previousKey) !== JSON.stringify(key)) {
          throw new Error(`cdc: primary-key value changed for ${id}`)
        }
        const position = event.nextPosition
        const source = {
          database: route.database,
          table: route.table,
          file,
          position,
          ...(event.gtid === undefined ? {} : { gtid: event.gtid }),
        }
        const cdcEvent: CdcEvent = {
          specVersion: 1,
          eventId: digest(`${source.file}:${position}:${rowIndex}:${operation}:${JSON.stringify(key)}`),
          operation,
          occurredAt,
          source,
          key,
          before: normalizedBefore === null ? null : excludedImage(normalizedBefore, route.excluded),
          after: normalizedAfter === null ? null : excludedImage(normalizedAfter, route.excluded),
          changedColumns: findChangedColumns(normalizedBefore, normalizedAfter),
          schemaFingerprint: fingerprint,
        }
        const payload = encodeCdcEvent(cdcEvent)
        if (payload.byteLength > this.config.maxEventBytes) {
          throw new Error(`cdc: event exceeds maxEventBytes for ${id}`)
        }
        await this.publishWithRetry(async () => {
          await this.ctx.kafka.publish([{
            topic: KafkaTopic(route.topic),
            key: encodeKey(key),
            value: payload,
            headers: {
              'content-type': Buffer.from('application/json'),
              'cdc-spec-version': Buffer.from('1'),
              'cdc-event-id': Buffer.from(cdcEvent.eventId),
            },
          }])
        })
      }
    }, true)
  }

  private observeSchema(id: string, fingerprint: string): void {
    const previous = this.observedSchemas.get(id)
    if (previous !== undefined && previous !== fingerprint) {
      this.state = 'paused-schema'
      throw new Error(`cdc: schema changed for ${id}`)
    }
    if (previous === undefined) this.observedSchemas.set(id, fingerprint)
  }

  private enqueueCheckpoint(position: number): void {
    if (this.currentFile.length === 0 || position < 4) {
      throw new Error('cdc: cannot checkpoint an invalid binlog position')
    }
    const schemas: Record<string, string> = Object.fromEntries(this.observedSchemas)
    const checkpoint: CdcCheckpoint = { version: 1, file: this.currentFile, position, schemas }
    this.enqueue(Buffer.byteLength(JSON.stringify(checkpoint)), async () => {
      await writeCheckpoint(this.config.checkpointFile, checkpoint)
      this.checkpoint = checkpoint
    })
  }

  private enqueue(bytes: number, operation: () => Promise<void>, enforceLimit = false): void {
    const sequence = ++this.queueSequence
    const accountedBytes = Math.min(Math.max(Math.ceil(bytes), 1), this.config.maxQueueBytes)
    if (
      enforceLimit && this.queuedBytes > 0
      && this.queuedBytes + accountedBytes > this.config.maxQueueBytes
    ) throw new Error('cdc: buffered binlog events exceed maxQueueBytes')
    this.queuedBytes += accountedBytes
    if (this.queuedBytes >= this.config.maxQueueBytes * 0.75 && this.reader.connection !== null) {
      this.reader.connection.pause()
      this.state = 'backpressured'
    }
    this.tail = this.tail.then(async () => {
      if (
        (this.terminalFailureSequence === undefined || sequence <= this.terminalFailureSequence)
        && (this.queueFailureSequence === undefined || sequence <= this.queueFailureSequence)
      ) await operation()
    }).catch((cause: unknown) => {
      const error = cause instanceof Error
        ? cause
        : new Error('cdc: queued operation failed', { cause })
      if (error instanceof CdcShutdownError && this.terminalFailure !== undefined) return
      this.queueFailure ??= error
      this.queueFailureSequence ??= sequence
      if (!this.stopping) this.terminate(error, sequence)
    }).finally(() => {
      this.queuedBytes -= accountedBytes
      if (
        this.state === 'backpressured'
        && this.queuedBytes < this.config.maxQueueBytes / 2
        && this.reader.connection !== null
      ) {
        this.reader.connection.resume()
        this.state = 'streaming'
      }
    })
  }

  private async publishWithRetry(operation: () => Promise<void>): Promise<void> {
    for (let failures = 0; ; failures += 1) {
      try {
        await operation()
        if (
          this.state === 'retrying' && this.recovery === undefined
          && this.reader.connection !== null
        ) {
          if (this.queuedBytes < this.config.maxQueueBytes / 2) {
            this.reader.connection.resume()
            this.state = 'streaming'
          } else {
            this.state = 'backpressured'
          }
        }
        return
      } catch (cause) {
        if (this.stopping) {
          throw new CdcShutdownError('cdc: publication failed during disposal', { cause })
        }
        const nextFailure = failures + 1
        if (!recoverableKafkaError(cause) || !canRetry(this.config, nextFailure)) {
          throw new Error('cdc: Kafka publication failed', { cause })
        }
        this.reader.connection?.pause()
        this.state = 'retrying'
        const delayMs = retryDelay(this.config, nextFailure)
        this.ctx.logger.warn(`cdc: Kafka publication failed; retrying in ${delayMs}ms`)
        if (!await this.waitForRetry(delayMs)) {
          throw new CdcShutdownError('cdc: publication retry stopped', { cause })
        }
      }
    }
  }

  private waitForRetry(delayMs: number): Promise<boolean> {
    if (this.shutdown.signal.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const abort = (): void => {
        clearTimeout(timer)
        resolve(false)
      }
      const timer = setTimeout(() => {
        this.shutdown.signal.removeEventListener('abort', abort)
        resolve(true)
      }, delayMs)
      this.shutdown.signal.addEventListener('abort', abort, { once: true })
    })
  }

  private terminate(error: Error, admittedThrough = this.queueSequence): void {
    if (this.terminalFailure !== undefined || this.stopping) return
    this.terminalFailure = error
    this.terminalFailureSequence = admittedThrough
    if (this.state !== 'paused-schema') this.state = 'failed'
    this.ctx.logger.error(`cdc stopped: ${error.message}`)
    this.shutdown.abort(error)
    const stopping = this.stopReader()
    this.terminalQuiescence = (async () => {
      let failure = error
      try {
        await stopping
      } catch (cause) {
        failure = new Error('cdc: reader shutdown failed after terminal failure', {
          cause: new AggregateError([error, cause]),
        })
      }
      await this.tail
      await this.recovery
      this.settleCompletion(failure)
    })()
  }

  private settleCompletion(error?: Error): void {
    if (this.completionSettled) return
    this.completionSettled = true
    if (error === undefined) this.completion.resolve()
    else this.completion.reject(error)
  }

  private stopReader(): Promise<void> {
    if (this.stopOperation !== undefined) return this.stopOperation
    this.readerAccepting = false
    const stopped = Promise.withResolvers<void>()
    this.expectedStops += 1
    const onStopped = (): void => { stopped.resolve() }
    const operation = withDeadline(
      () => stopped.promise,
      this.config.connectTimeoutMs,
      'replication reader stop',
      () => {
        this.reader.off('stopped', onStopped)
        this.expectedStops = Math.max(this.expectedStops - 1, 0)
        this.ignoreStoppedBeforeReady = true
      },
    ).finally(() => {
      if (this.stopOperation === operation) this.stopOperation = undefined
    })
    this.stopOperation = operation
    this.reader.once('stopped', onStopped)
    try {
      this.reader.stop()
    } catch (cause) {
      this.reader.off('stopped', onStopped)
      this.expectedStops -= 1
      stopped.reject(cause)
    }
    return operation
  }

  private close(): Promise<void> {
    this.closeOperation ??= this.closeImpl()
    return this.closeOperation
  }

  private async closeImpl(): Promise<void> {
    this.stopping = true
    this.shutdown.abort()
    const stopping = this.stopReader()
    const lifecycle = await Promise.allSettled([
      stopping,
      this.recovery ?? Promise.resolve(),
    ])
    const draining = await Promise.allSettled([this.tail])
    const terminal = await Promise.allSettled([
      this.terminalQuiescence ?? Promise.resolve(),
    ])
    this.state = 'stopped'
    const failures = [...lifecycle, ...draining, ...terminal]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown)
    if (this.queueFailure !== undefined) failures.push(this.queueFailure)
    if (failures.length > 0) {
      const error = failures.length === 1 && failures[0] instanceof Error
        ? failures[0]
        : new Error('cdc: shutdown failed', { cause: new AggregateError(failures) })
      this.settleCompletion(error)
      throw error
    }
    this.settleCompletion()
  }
}

export default CdcService
