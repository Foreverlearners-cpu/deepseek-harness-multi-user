import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import CdcService, { decodeCdcEvent, type Config } from '@deepseek-ai/dsh-cdc'
import { KafkaError, type KafkaPublishMessage } from '@deepseek-ai/dsh-kafka'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  autoReady: true,
  binlogTail: { file: 'mysql-bin.000001', position: '4' },
  columns: ['id', 'name', 'secret', 'created_at', 'zero_date'],
  connectionFailures: [] as Error[],
  constructorOptions: undefined as unknown,
  end: vi.fn(),
  destroy: vi.fn(),
  instance: undefined as unknown,
  metadataDatabase: 'app',
  metadataTable: 'users',
  pendingStops: [] as Array<() => void>,
  primaryKey: ['id'],
  deferStop: false,
  neverSettleEnd: false,
  neverSettleQuery: false,
  startFailures: [] as Error[],
  variables: {
    logBin: 'ON',
    binlogFormat: 'ROW',
    binlogRowImage: 'FULL',
    binlogRowMetadata: 'FULL',
    binlogTransactionCompression: 'OFF',
    binlogRowValueOptions: '',
  },
}))

interface StartOptions {
  startAtEnd?: boolean
  filename?: string
  position?: number
}

interface TableHarness {
  columnSchemas: Array<{
    COLUMN_NAME: string
    COLUMN_TYPE: string
    UNSIGNED?: boolean
    CHARACTER_SET_NAME: string | null
    COLLATION_NAME: string | null
    COLUMN_COMMENT: string
  }>
  parentSchema: string
  tableName: string
}

interface ReaderHarness {
  readonly tableMap: Record<number, TableHarness>
  connection: { pause(): void; resume(): void } | null
  readonly options: { filename?: string; position?: number }
  startOptions?: StartOptions
  startCount: number
  stopped: boolean
  emit(event: string, value?: unknown): void
}

vi.mock('@vlasky/zongji', () => ({
  default: class {
    readonly tableMap: ReaderHarness['tableMap'] = {}
    connection: ReaderHarness['connection'] = null
    readonly options: { filename?: string; position?: number } = {}
    readonly listeners = new Map<string, Array<(value?: unknown) => void>>()
    startOptions?: StartOptions
    startCount = 0
    stopped = false
    private epoch = 0

    constructor(options: unknown) {
      mock.constructorOptions = options
      mock.instance = this
    }

    on(event: string, listener: (value?: unknown) => void): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    once(event: string, listener: (value?: unknown) => void): this {
      const wrapped = (value?: unknown): void => {
        this.off(event, wrapped)
        listener(value)
      }
      return this.on(event, wrapped)
    }

    off(event: string, listener: (value?: unknown) => void): this {
      const listeners = this.listeners.get(event)
      if (listeners !== undefined) {
        this.listeners.set(event, listeners.filter(candidate => candidate !== listener))
      }
      return this
    }

    emit(event: string, value?: unknown): void {
      for (const listener of [...this.listeners.get(event) ?? []]) listener(value)
    }

    start(options: StartOptions): void {
      const failure = mock.startFailures.shift()
      if (failure !== undefined) throw failure
      this.startCount += 1
      this.startOptions = options
      this.options.filename = options.filename ?? 'mysql-bin.000001'
      this.options.position = options.position ?? 4
      this.stopped = false
      this.connection = { pause: vi.fn(), resume: vi.fn() }
      this.epoch += 1
      const epoch = this.epoch
      if (mock.autoReady) {
        queueMicrotask(() => {
          if (!this.stopped && epoch === this.epoch) this.emit('ready')
        })
      }
    }

    stop(): void {
      this.epoch += 1
      this.stopped = true
      this.connection = null
      const finish = (): void => { this.emit('stopped') }
      if (mock.deferStop) mock.pendingStops.push(finish)
      else finish()
    }
  },
}))

vi.mock('mysql2/promise', () => ({
  createConnection: vi.fn(async () => {
    const failure = mock.connectionFailures.shift()
    if (failure !== undefined) throw failure
    return {
      query: vi.fn(async (sql: string) => {
        if (mock.neverSettleQuery) return new Promise<never>(() => {})
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
          return [mock.columns.map(columnName => ({
            databaseName: mock.metadataDatabase,
            tableName: mock.metadataTable,
            columnName,
          }))]
        }
        if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) {
          return [mock.primaryKey.map(columnName => ({ columnName }))]
        }
        if (sql.includes('SHOW BINARY LOGS')) {
          return [[{ Log_name: mock.binlogTail.file, File_size: mock.binlogTail.position }]]
        }
        return [[mock.variables]]
      }),
      end: mock.end,
      destroy: mock.destroy,
    }
  }),
}))

class FakeKafka extends Service {
  readonly attempts: KafkaPublishMessage[][] = []
  readonly publications: KafkaPublishMessage[][] = []
  onPublish?: (messages: KafkaPublishMessage[]) => Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'kafka')
  }

  async publish(messages: KafkaPublishMessage[]): Promise<[]> {
    this.attempts.push(messages)
    await this.onPublish?.(messages)
    this.publications.push(messages)
    return []
  }
}

const directories: string[] = []

async function setup(overrides: Partial<Config> = {}): Promise<{
  checkpointFile: string
  config: Config
  ctx: Context
  kafka: FakeKafka
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cdc-service-'))
  directories.push(directory)
  const checkpointFile = join(directory, 'checkpoint.json')
  const ctx = new Context()
  await ctx.plugin(FakeKafka)
  const kafka = ctx.kafka as unknown as FakeKafka
  return {
    checkpointFile,
    config: {
      host: 'mysql.internal',
      user: 'replicator',
      password: 'secret',
      serverId: 77,
      checkpointFile,
      routes: [{
        database: 'app',
        table: 'users',
        topic: 'app.users',
        primaryKey: ['id'],
        excludeColumns: ['secret'],
      }],
      port: 3306,
      connectTimeoutMs: 1_000,
      maxEventBytes: 10_000,
      maxBinlogEventBytes: 100_000,
      maxQueueBytes: 20_000,
      retryInitialDelayMs: 1,
      retryMaxDelayMs: 10,
      maxRetries: 'unlimited',
      ...overrides,
    },
    ctx,
    kafka,
  }
}

function reader(): ReaderHarness {
  return mock.instance as ReaderHarness
}

function fullBitmap(columns = 5): Buffer {
  const bitmap = Buffer.alloc(Math.ceil(columns / 8), 0xff)
  const excess = bitmap.length * 8 - columns
  if (excess > 0) bitmap[bitmap.length - 1] = 0xff >>> excess
  return bitmap
}

function tableMetadata(characterSet = 'utf8mb4'): TableHarness {
  return {
    columnSchemas: [
      {
        COLUMN_NAME: 'id', COLUMN_TYPE: 'bigint', UNSIGNED: true,
        CHARACTER_SET_NAME: null, COLLATION_NAME: null, COLUMN_COMMENT: '',
      },
      {
        COLUMN_NAME: 'name', COLUMN_TYPE: 'varchar(255)',
        CHARACTER_SET_NAME: characterSet,
        COLLATION_NAME: `${characterSet}_0900_ai_ci`, COLUMN_COMMENT: '',
      },
      {
        COLUMN_NAME: 'secret', COLUMN_TYPE: 'varchar(255)',
        CHARACTER_SET_NAME: characterSet,
        COLLATION_NAME: `${characterSet}_0900_ai_ci`, COLUMN_COMMENT: '',
      },
      {
        COLUMN_NAME: 'created_at', COLUMN_TYPE: 'datetime(6)',
        CHARACTER_SET_NAME: null, COLLATION_NAME: null, COLUMN_COMMENT: '',
      },
      {
        COLUMN_NAME: 'zero_date', COLUMN_TYPE: 'date',
        CHARACTER_SET_NAME: null, COLLATION_NAME: null, COLUMN_COMMENT: '',
      },
    ],
    parentSchema: 'app',
    tableName: 'users',
  }
}

function emitTableMap(options: { primaryKey?: number[]; characterSet?: string } = {}): void {
  reader().tableMap[1] = tableMetadata(options.characterSet)
  reader().emit('binlog', {
    getEventName: () => 'tablemap',
    schemaName: 'app',
    tableName: 'users',
    tableId: 1,
    tableMap: reader().tableMap,
    columnNames: ['id', 'name', 'secret', 'created_at', 'zero_date'],
    primaryKey: options.primaryKey ?? [0],
    hasSelfDescribingMetadata: () => true,
  })
}

function emitRows(
  name: 'writerows' | 'updaterows' | 'deleterows',
  rows: unknown[],
  options: {
    bitmap?: Uint8Array
    bitmap2?: Uint8Array
    nextPosition?: number
    size?: number
  } = {},
): void {
  reader().emit('binlog', {
    getEventName: () => name,
    tableId: 1,
    tableMap: reader().tableMap,
    rows,
    numberOfColumns: 5,
    columns_present_bitmap: options.bitmap ?? fullBitmap(),
    ...(name === 'updaterows'
      ? { columns_present_bitmap2: options.bitmap2 ?? fullBitmap() }
      : {}),
    nextPosition: options.nextPosition ?? 120,
    timestamp: Date.parse('2026-08-19T12:00:00.000Z'),
    size: options.size ?? 500,
    gtid: 'source:8',
  })
}

function emitQuery(query: string, schema = 'app', nextPosition = 90): void {
  reader().emit('binlog', {
    getEventName: () => 'query',
    query,
    schema,
    nextPosition,
  })
}

function row(id = '42', name = 'Ada'): Record<string, unknown> {
  return {
    id,
    name,
    secret: 'hidden',
    created_at: '2026-08-19 12:00:00.123456',
    zero_date: '0000-00-00',
  }
}

async function checkpoint(path: string): Promise<{
  file: string
  position: number
  schemas: Record<string, string>
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    file: string
    position: number
    schemas: Record<string, string>
  }
}

beforeEach(() => {
  mock.instance = undefined
  mock.constructorOptions = undefined
  mock.autoReady = true
  mock.binlogTail.file = 'mysql-bin.000001'
  mock.binlogTail.position = '4'
  mock.columns.splice(0, mock.columns.length, 'id', 'name', 'secret', 'created_at', 'zero_date')
  mock.connectionFailures.length = 0
  mock.deferStop = false
  mock.neverSettleEnd = false
  mock.neverSettleQuery = false
  mock.pendingStops.length = 0
  mock.metadataDatabase = 'app'
  mock.metadataTable = 'users'
  mock.primaryKey.splice(0, mock.primaryKey.length, 'id')
  mock.startFailures.length = 0
  mock.variables.logBin = 'ON'
  mock.variables.binlogFormat = 'ROW'
  mock.variables.binlogRowImage = 'FULL'
  mock.variables.binlogRowMetadata = 'FULL'
  mock.variables.binlogTransactionCompression = 'OFF'
  mock.variables.binlogRowValueOptions = ''
  mock.end.mockReset().mockImplementation(async () => {
    if (mock.neverSettleEnd) return new Promise<never>(() => {})
  })
  mock.destroy.mockReset()
})

afterEach(async () => {
  vi.useRealTimers()
  for (const finish of mock.pendingStops.splice(0)) finish()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('CdcService', () => {
  it('durably checkpoints the initial tail and preserves exact temporal strings', async () => {
    const { checkpointFile, config, ctx, kafka } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    const cdc = ctx.cdc

    expect(reader().startOptions).toMatchObject({
      startAtEnd: false,
      filename: 'mysql-bin.000001',
      position: 4,
    })
    await expect(checkpoint(checkpointFile)).resolves.toMatchObject({
      file: 'mysql-bin.000001',
      position: 4,
      schemas: {},
    })
    expect(mock.constructorOptions).toMatchObject({
      connectTimeout: 1_000,
      dateStrings: true,
      timezone: 'Z',
    })

    emitTableMap()
    emitRows('writerows', [row()])
    reader().emit('binlog', { getEventName: () => 'xid', nextPosition: 140 })

    await vi.waitFor(() => { expect(kafka.publications).toHaveLength(1) })
    await vi.waitFor(async () => { expect((await checkpoint(checkpointFile)).position).toBe(140) })
    expect(decodeCdcEvent(kafka.publications[0]?.[0]?.value ?? Buffer.alloc(0))).toMatchObject({
      operation: 'insert',
      key: { id: '42' },
      after: {
        id: '42',
        name: 'Ada',
        created_at: '2026-08-19 12:00:00.123456',
        zero_date: '0000-00-00',
      },
      changedColumns: ['id', 'name', 'secret', 'created_at', 'zero_date'],
    })
    await fiber.dispose()
    await expect(cdc.done).resolves.toBeUndefined()
  })

  it('publishes updates in order and resumes from the committed transaction position', async () => {
    const first = await setup()
    const firstFiber = await first.ctx.plugin(CdcService, first.config)
    emitTableMap()
    emitRows('updaterows', [{ before: row(), after: row('42', 'Grace') }], { nextPosition: 130 })
    reader().emit('binlog', { getEventName: () => 'xid', nextPosition: 140 })
    await vi.waitFor(async () => { expect((await checkpoint(first.checkpointFile)).position).toBe(140) })
    expect(decodeCdcEvent(first.kafka.publications[0]?.[0]?.value ?? Buffer.alloc(0))).toMatchObject({
      operation: 'update',
      changedColumns: ['name'],
      before: { name: 'Ada' },
      after: { name: 'Grace' },
    })
    await firstFiber.dispose()

    const nextContext = new Context()
    await nextContext.plugin(FakeKafka)
    const nextFiber = await nextContext.plugin(CdcService, first.config)
    expect(reader().startOptions).toMatchObject({
      startAtEnd: false,
      filename: 'mysql-bin.000001',
      position: 140,
    })
    await nextFiber.dispose()
  })

  it('checkpoints a binlog rotation for an idle restart', async () => {
    const { checkpointFile, config, ctx } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    reader().emit('binlog', {
      getEventName: () => 'rotate',
      binlogName: 'mysql-bin.000002',
      position: 4,
    })
    await vi.waitFor(async () => {
      expect(await checkpoint(checkpointFile)).toMatchObject({ file: 'mysql-bin.000002', position: 4 })
    })
    await fiber.dispose()
  })

  it('fails before publication for primary-key and excluded-column metadata mismatches', async () => {
    const primary = await setup()
    const primaryFiber = await primary.ctx.plugin(CdcService, primary.config)
    emitTableMap({ primaryKey: [1] })
    await expect(primary.ctx.cdc.done).rejects.toThrow(/primary key/u)
    expect(primary.kafka.publications).toEqual([])
    await primaryFiber.dispose()

    const excluded = await setup({
      routes: [{
        database: 'app', table: 'users', topic: 'app.users',
        primaryKey: ['id'], excludeColumns: ['secrett'],
      }],
    })
    await expect(excluded.ctx.plugin(CdcService, excluded.config)).rejects.toThrow(/configured column/u)
    expect(excluded.kafka.publications).toEqual([])
  })

  it('rejects a missing routed table during startup instead of reporting healthy streaming', async () => {
    mock.columns.length = 0
    const { config, ctx } = await setup({ maxRetries: 0 })

    await expect(ctx.plugin(CdcService, config)).rejects.toThrow(/routed table.*unavailable/u)
  })

  it('rejects routed table names whose metadata casing would miss the binlog filter', async () => {
    mock.metadataTable = 'Users'
    const { config, ctx } = await setup({ maxRetries: 0 })

    await expect(ctx.plugin(CdcService, config)).rejects.toThrow(/routed table.*unavailable/u)
  })

  it('rejects an invalid binary log tail before starting replication', async () => {
    mock.binlogTail.position = 'not-a-position'
    const { config, ctx } = await setup({ maxRetries: 0 })

    await expect(ctx.plugin(CdcService, config)).rejects.toThrow(/valid binary log tail/u)
    expect(reader().startCount).toBe(0)
  })

  it('bounds reader readiness and stop cleanup when ZongJi never becomes ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mock.autoReady = false
    mock.deferStop = true
    const { config, ctx } = await setup({ connectTimeoutMs: 25, maxRetries: 0 })
    const activation = ctx.plugin(CdcService, config)

    console.log('CDC DEBUG readiness before flush', vi.getTimerCount())
    await Promise.resolve()
    await Promise.resolve()
    console.log('CDC DEBUG readiness after flush', vi.getTimerCount())
    await vi.runAllTimersAsync()
    console.log('CDC DEBUG readiness after timers', vi.getTimerCount())
    await expect(activation).rejects.toThrow(/startup cleanup failed|startup retries exhausted/u)
    expect(reader().startCount).toBe(1)
    expect(mock.pendingStops.length).toBeGreaterThan(0)
  })

  it('bounds a metadata query that never settles and destroys its connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mock.neverSettleQuery = true
    const { config, ctx } = await setup({ connectTimeoutMs: 25, maxRetries: 0 })
    const activation = ctx.plugin(CdcService, config)

    await Promise.resolve()
    await Promise.resolve()
    await vi.runAllTimersAsync()
    await expect(activation).rejects.toThrow(/startup retries exhausted/u)
    expect(mock.destroy).toHaveBeenCalled()
  })

  it('bounds MySQL connection close when validation succeeds but end never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mock.neverSettleEnd = true
    const { config, ctx } = await setup({ connectTimeoutMs: 25, maxRetries: 0 })
    const activation = ctx.plugin(CdcService, config)

    await Promise.resolve()
    await Promise.resolve()
    await vi.runAllTimersAsync()
    await expect(activation).rejects.toThrow(/startup retries exhausted/u)
    expect(mock.end).toHaveBeenCalled()
    expect(mock.destroy).toHaveBeenCalled()
  })

  it('retries a recoverable MySQL failure during initial startup', async () => {
    mock.connectionFailures.push(Object.assign(new Error('not ready'), { code: 'ECONNREFUSED' }))
    const { config, ctx } = await setup()

    const fiber = await ctx.plugin(CdcService, config)

    expect(ctx.cdc.status).toBe('streaming')
    expect(reader().startCount).toBe(1)
    await fiber.dispose()
  })

  it('uses a synchronous schema baseline and fingerprints charset metadata', async () => {
    const { config, ctx } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    emitTableMap({ characterSet: 'utf8mb4' })
    emitTableMap({ characterSet: 'latin1' })
    await expect(ctx.cdc.done).rejects.toThrow(/schema changed/u)
    expect(ctx.cdc.status).toBe('paused-schema')
    await fiber.dispose()
  })

  it('rejects incomplete row-image bitmaps after a runtime MySQL setting change', async () => {
    const { config, ctx, kafka } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    emitTableMap()
    emitRows('updaterows', [{ before: row(), after: row('42', 'Grace') }], {
      bitmap2: Buffer.from([0b0_1111]),
    })
    await expect(ctx.cdc.done).rejects.toThrow(/incomplete row image/u)
    expect(kafka.publications).toEqual([])
    await fiber.dispose()
  })

  it.each([
    ['/* source session */ UPDATE users SET name = \'lost\' WHERE id = 42'],
    ['INSERT INTO users VALUES (42)'],
    ['/*!80000 UPDATE users SET name = \'lost\' WHERE id = 42 */'],
    ["XA START 'transaction-1'"],
  ])('fails closed for unsupported Query event %s', async (query) => {
    const { config, ctx, kafka } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    emitQuery(query)
    await expect(ctx.cdc.done).rejects.toThrow(/statement-based DML|XA/u)
    expect(kafka.publications).toEqual([])
    await fiber.dispose()
  })

  it.each([
    ['DROP TABLE `app`.`users`'],
    ['DROP DATABASE `app`'],
    ['RENAME TABLE `app`.`users` TO `archive`.`users`'],
    ['ALTER TABLE `app`.`users` RENAME TO `archive`.`users`'],
    ['ALTER ONLINE IGNORE TABLE `app`.`users` ADD COLUMN `email` TEXT'],
    ['ALTER OFFLINE TABLE `audit`.`logs` ADD COLUMN `source` TEXT'],
    ['RENAME TABLE `audit`.`logs` TO `archive`.`logs`, `app`.`users` TO `archive`.`users`'],
    ['CREATE TABLE `audit`.`users_copy` LIKE `app`.`users`'],
    ['/*!50000 DROP TABLE `app`.`users` */'],
  ])('fails closed without advancing the checkpoint for schema DDL %s', async (query) => {
    const { checkpointFile, config, ctx, kafka } = await setup()
    const fiber = await ctx.plugin(CdcService, config)

    emitQuery(query, 'app', 90)
    reader().emit('binlog', { getEventName: () => 'xid', nextPosition: 100 })
    reader().emit('binlog', {
      getEventName: () => 'rotate',
      binlogName: 'mysql-bin.000002',
      position: 4,
    })

    await expect(ctx.cdc.done).rejects.toThrow(/schema-changing DDL/u)
    expect(await checkpoint(checkpointFile)).toMatchObject({
      file: 'mysql-bin.000001',
      position: 4,
    })
    expect(kafka.publications).toEqual([])
    await fiber.dispose()
  })

  it('drains a row admitted before a terminal statement event', async () => {
    const { config, ctx, kafka } = await setup()
    const publication = Promise.withResolvers<undefined>()
    kafka.onPublish = async () => publication.promise
    const fiber = await ctx.plugin(CdcService, config)

    emitTableMap()
    emitRows('writerows', [row()], { nextPosition: 120 })
    emitQuery('UPDATE users SET name = \'unsafe\' WHERE id = 42')
    await vi.waitFor(() => { expect(kafka.attempts).toHaveLength(1) })

    publication.resolve(undefined)
    await expect(ctx.cdc.done).rejects.toThrow(/statement-based DML/u)
    expect(kafka.publications).toHaveLength(1)
    await fiber.dispose()
  })

  it('fails closed for an XA prepare marker even without its start query', async () => {
    const { config, ctx } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    reader().emit('binlog', { getEventName: () => 'xaprepare' })
    await expect(ctx.cdc.done).rejects.toThrow(/unsupported MySQL event/u)
    await fiber.dispose()
  })

  it('checkpoints unrelated TRUNCATE but stops for a routed table', async () => {
    const { checkpointFile, config, ctx } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    emitQuery('TRUNCATE TABLE `audit`.`logs`', 'audit', 90)
    await vi.waitFor(async () => { expect((await checkpoint(checkpointFile)).position).toBe(90) })
    expect(ctx.cdc.status).toBe('streaming')

    emitQuery('TRUNCATE TABLE `app`.`users`', 'app', 100)
    await expect(ctx.cdc.done).rejects.toThrow(/TRUNCATE cannot be represented/u)
    await fiber.dispose()
  })

  it('stops rather than moving an update between Kafka partitions', async () => {
    const { config, ctx, kafka } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    emitTableMap()
    emitRows('updaterows', [{ before: row('42'), after: row('43') }])
    await expect(ctx.cdc.done).rejects.toThrow(/primary-key value changed/u)
    expect(kafka.publications).toEqual([])
    await fiber.dispose()
  })

  it('streams a single RowsEvent larger than the queue watermark one row at a time', async () => {
    const { checkpointFile, config, ctx, kafka } = await setup({
      maxEventBytes: 2_000,
      maxQueueBytes: 2_000,
      maxBinlogEventBytes: 10_000,
    })
    const fiber = await ctx.plugin(CdcService, config)
    emitTableMap()
    emitRows('writerows', [row('42'), row('43')], { size: 5_000 })
    reader().emit('binlog', { getEventName: () => 'xid', nextPosition: 140 })
    await vi.waitFor(() => { expect(kafka.publications).toHaveLength(2) })
    await vi.waitFor(async () => { expect((await checkpoint(checkpointFile)).position).toBe(140) })
    await fiber.dispose()
  })

  it('rejects a decoded RowsEvent above its independent processing cap', async () => {
    const { config, ctx } = await setup({ maxBinlogEventBytes: 100 })
    const fiber = await ctx.plugin(CdcService, config)
    emitTableMap()
    emitRows('writerows', [row()], { size: 101 })
    await expect(ctx.cdc.done).rejects.toThrow(/maxBinlogEventBytes/u)
    await fiber.dispose()
  })

  it('retries recoverable Kafka publication failures without rejecting buffered events', async () => {
    const { checkpointFile, config, ctx, kafka } = await setup({
      retryInitialDelayMs: 200,
      retryMaxDelayMs: 200,
    })
    let failures = 0
    kafka.onPublish = async () => {
      if (failures === 0) {
        failures += 1
        throw new KafkaError('unavailable', 'test')
      }
    }
    const fiber = await ctx.plugin(CdcService, config)
    emitTableMap()
    emitRows('writerows', [row('42')], { nextPosition: 120 })
    await vi.waitFor(() => { expect(ctx.cdc.status).toBe('retrying') })
    emitRows('writerows', [row('43')], { nextPosition: 130 })
    reader().emit('binlog', { getEventName: () => 'xid', nextPosition: 140 })

    await vi.waitFor(() => { expect(kafka.publications).toHaveLength(2) })
    await vi.waitFor(async () => { expect((await checkpoint(checkpointFile)).position).toBe(140) })
    expect(ctx.cdc.lastError).toBeUndefined()
    await fiber.dispose()
  })

  it('rejects done after Kafka retries are exhausted and keeps the old checkpoint', async () => {
    const { checkpointFile, config, ctx, kafka } = await setup({ maxRetries: 0 })
    kafka.onPublish = async () => { throw new KafkaError('unavailable', 'test') }
    const fiber = await ctx.plugin(CdcService, config)
    emitTableMap()
    emitRows('writerows', [row()])
    reader().emit('binlog', { getEventName: () => 'xid', nextPosition: 140 })

    await expect(ctx.cdc.done).rejects.toThrow(/Kafka publication failed/u)
    expect((await checkpoint(checkpointFile)).position).toBe(4)
    expect(ctx.cdc.status).toBe('failed')
    expect(kafka.attempts).toHaveLength(1)
    await fiber.dispose()
  })

  it('restarts the MySQL reader after a recoverable runtime disconnect', async () => {
    const { config, ctx } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    const error = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
    reader().emit('error', error)
    await vi.waitFor(() => { expect(reader().startCount).toBe(2) })
    await vi.waitFor(() => { expect(ctx.cdc.status).toBe('streaming') })
    expect(reader().startOptions).toMatchObject({
      startAtEnd: false,
      filename: 'mysql-bin.000001',
      position: 4,
    })
    await fiber.dispose()
  })

  it('does not reject done until an asynchronously stopping reader is quiescent', async () => {
    const { config, ctx } = await setup()
    const fiber = await ctx.plugin(CdcService, config)
    mock.deferStop = true
    emitQuery('UPDATE users SET name = \'lost\'')
    let settled = false
    void ctx.cdc.done.catch(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    for (const finish of mock.pendingStops.splice(0)) finish()
    await expect(ctx.cdc.done).rejects.toThrow(/statement-based DML/u)
    mock.deferStop = false
    await fiber.dispose()
  })

  it('propagates an in-flight publish failure during disposal without advancing checkpoint', async () => {
    const { checkpointFile, config, ctx, kafka } = await setup()
    const publishing = Promise.withResolvers<undefined>()
    kafka.onPublish = () => publishing.promise
    const fiber = await ctx.plugin(CdcService, config)
    const cdc = ctx.cdc
    emitTableMap()
    emitRows('writerows', [row()])
    reader().emit('binlog', { getEventName: () => 'xid', nextPosition: 140 })
    await vi.waitFor(() => { expect(kafka.attempts).toHaveLength(1) })

    const disposing = fiber.dispose()
    publishing.reject(new KafkaError('unavailable', 'test'))
    await disposing
    expect((await checkpoint(checkpointFile)).position).toBe(4)
    expect(kafka.publications).toEqual([])
    await expect(cdc.done).rejects.toThrow(/publication failed during disposal/u)
  })
})
