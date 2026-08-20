import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CdcService, { decodeCdcEvent, type CdcEvent } from '@deepseek-ai/dsh-cdc'
import { apply as applyElasticsearch } from '@deepseek-ai/dsh-cdc-elasticsearch'
import { apply as applyRedis } from '@deepseek-ai/dsh-cdc-redis'
import ElasticsearchService from '@deepseek-ai/dsh-elasticsearch'
import KafkaService, {
  KafkaConsumerGroupId,
  KafkaSubscriptionId,
  KafkaTopic,
} from '@deepseek-ai/dsh-kafka'
import Redis from '@deepseek-ai/dsh-redis'
import { createConnection } from 'mysql2/promise'

const mysqlHost = process.env.DSH_CDC_MYSQL_HOST ?? '127.0.0.1'
const mysqlPort = Number(process.env.DSH_CDC_MYSQL_PORT ?? '13306')
const mysqlCdcUser = process.env.DSH_CDC_MYSQL_CDC_USER ?? 'dsh_cdc'
const mysqlCdcPassword = process.env.DSH_CDC_MYSQL_CDC_PASSWORD ?? 'dsh_cdc_test'
const mysqlWriterUser = process.env.DSH_CDC_MYSQL_WRITER_USER ?? 'root'
const mysqlWriterPassword = process.env.DSH_CDC_MYSQL_WRITER_PASSWORD ?? 'dsh_cdc_root_test'
const kafkaBroker = process.env.DSH_CDC_KAFKA_BROKER ?? '127.0.0.1:19092'
const redisUrl = process.env.DSH_CDC_REDIS_URL ?? 'redis://127.0.0.1:6379'
const elasticsearchNode = process.env.DSH_CDC_ELASTICSEARCH_NODE ?? 'http://127.0.0.1:9200'
const usersTopic = process.env.DSH_CDC_USERS_TOPIC ?? 'dsh.cdc.users'
const ordersTopic = process.env.DSH_CDC_ORDERS_TOPIC ?? 'dsh.cdc.orders'
const runId = `${Date.now()}-${process.pid}`
const redisUsersPrefix = `dsh-cdc-test:${runId}:users`
const redisOrdersPrefix = `dsh-cdc-test:${runId}:orders`
const usersIndex = `dsh-cdc-test-users-${runId}`
const ordersIndex = `dsh-cdc-test-orders-${runId}`
const stateIndex = `dsh-cdc-test-state-${runId}`
const testIndices = `${usersIndex},${ordersIndex},${stateIndex}`

async function waitFor(description: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (cause) {
      lastError = cause
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`live smoke timed out waiting for ${description}`, { cause: lastError })
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cdc-live-'))
  const checkpointFile = join(directory, 'checkpoint.json')
  const ctx = new Context()
  ctx.logger.error = ((message: unknown) => { console.error(message) }) as typeof ctx.logger.error
  ctx.logger.warn = ((message: unknown) => { console.warn(message) }) as typeof ctx.logger.warn
  const events: CdcEvent[] = []
  let elasticsearchReady = false
  let testIndicesDeleted = false
  const writer = await createConnection({
    host: mysqlHost,
    port: mysqlPort,
    user: mysqlWriterUser,
    password: mysqlWriterPassword,
    database: 'dsh_cdc_test',
  })

  try {
    await writer.query('DELETE FROM orders WHERE id <> 100')
    await writer.query('DELETE FROM users WHERE id <> 1')
    await ctx.plugin(KafkaService, {
      binding: 'cdc-live',
      brokers: [kafkaBroker],
      clientId: `dsh-cdc-live-${runId}`,
      tls: false,
      requestTimeoutMs: 10_000,
      connectionTimeoutMs: 5_000,
      retries: 3,
      retryDelayMs: 200,
      topics: [usersTopic, ordersTopic],
      consumerGroups: [
        `dsh-cdc-live-audit-${runId}`,
        `dsh-cdc-live-redis-${runId}`,
        `dsh-cdc-live-es-${runId}`,
      ],
      consumerHighWaterMark: 16,
    })
    await ctx.plugin(Redis, { url: redisUrl, connectTimeoutMs: 5_000 })
    await ctx.plugin(ElasticsearchService, {
      node: elasticsearchNode,
      allowInsecureHttp: true,
      maxRetries: 1,
      requestTimeoutMs: 10_000,
      pingTimeoutMs: 5_000,
    })
    elasticsearchReady = true

    await ctx.redis.withClient(async (client) => {
      const staleKeys = await client.keys('dsh-cdc-test:*')
      for (const key of staleKeys) await client.del(key)
    })
    await ctx.elasticsearch.operation(async (client) => {
      await client.indices.delete({ index: testIndices, ignore_unavailable: true }, { ignore: [404] })
    })

    await ctx.kafka.subscribe({
      id: KafkaSubscriptionId(`audit-${runId}`),
      groupId: KafkaConsumerGroupId(`dsh-cdc-live-audit-${runId}`),
      topics: [KafkaTopic(usersTopic), KafkaTopic(ordersTopic)],
      fallbackMode: 'latest',
      handle(message) {
        assert.notEqual(message.value, null)
        events.push(decodeCdcEvent(message.value as Buffer))
      },
    })
    await applyRedis(ctx, {
      subscriptionId: `redis-${runId}`,
      consumerGroup: `dsh-cdc-live-redis-${runId}`,
      topics: [usersTopic, ordersTopic],
      fallbackMode: 'latest',
      routes: [
        {
          database: 'dsh_cdc_test',
          table: 'users',
          topic: usersTopic,
          keyPrefix: redisUsersPrefix,
          watchedColumns: ['name'],
        },
        {
          database: 'dsh_cdc_test',
          table: 'orders',
          topic: ordersTopic,
          keyPrefix: redisOrdersPrefix,
          watchedColumns: ['amount', 'status'],
        },
      ],
    })
    await applyElasticsearch(ctx, {
      subscriptionId: `es-${runId}`,
      consumerGroup: `dsh-cdc-live-es-${runId}`,
      topics: [usersTopic, ordersTopic],
      fallbackMode: 'latest',
      stateIndex,
      routes: [
        {
          database: 'dsh_cdc_test',
          table: 'users',
          topic: usersTopic,
          index: usersIndex,
          watchedColumns: ['name'],
        },
        {
          database: 'dsh_cdc_test',
          table: 'orders',
          topic: ordersTopic,
          index: ordersIndex,
          watchedColumns: ['amount', 'status'],
        },
      ],
    })

    const producerConfig = {
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlCdcUser,
      password: mysqlCdcPassword,
      serverId: 7102,
      connectTimeoutMs: 5_000,
      checkpointFile,
      routes: [
        {
          database: 'dsh_cdc_test',
          table: 'users',
          topic: usersTopic,
          primaryKey: ['id'],
          excludeColumns: ['secret_note'],
        },
        {
          database: 'dsh_cdc_test',
          table: 'orders',
          topic: ordersTopic,
          primaryKey: ['id'],
        },
      ],
      maxEventBytes: 1_048_576,
      maxBinlogEventBytes: 67_108_864,
      maxQueueBytes: 16_777_216,
      retryInitialDelayMs: 200,
      retryMaxDelayMs: 2_000,
      maxRetries: 5,
    }
    let producer = await ctx.plugin(CdcService, producerConfig)

    await writer.query(`
      INSERT INTO users VALUES
        (2, 'Ada', 'ada@example.test', 'remove-me', '2026-08-20 10:01:00.000'),
        (3, 'Delete Me', 'delete@example.test', 'remove-me-too', '2026-08-20 10:01:01.000')
    `)
    await writer.query(`
      INSERT INTO orders VALUES
        (200, 2, 12.3400, 'created', '2026-08-20 10:02:00.000'),
        (201, 3, 99.9900, 'created', '2026-08-20 10:02:01.000')
    `)
    await writer.query("UPDATE users SET name='Ada Updated', secret_note='still-removed' WHERE id=2")
    await writer.query("UPDATE users SET email='not-projected@example.test' WHERE id=2")
    await writer.query("UPDATE orders SET amount=42.3400, status='paid' WHERE id=200")
    await writer.query('DELETE FROM users WHERE id=3')
    await writer.query('DELETE FROM orders WHERE id=201')

    try {
      await waitFor('the first nine Kafka events', async () => events.length === 9)
    } catch (cause) {
      let checkpoint: unknown = undefined
      try {
        checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'))
      } catch {
        // Include the missing checkpoint in the diagnostic when startup never reached ready.
      }
      console.error(JSON.stringify({
        cdc: {
          status: ctx.cdc.status,
          lastError: ctx.cdc.lastError?.stack ?? ctx.cdc.lastError?.message,
          doneSettled: await Promise.race([
            ctx.cdc.done.then(() => 'resolved', () => 'rejected'),
            new Promise<string>(resolve => setTimeout(() => { resolve('pending') }, 0)),
          ]),
          reader: (() => {
            const service = ctx.cdc as unknown as {
              reader?: {
                ready?: boolean
                stopped?: boolean
                _starting?: boolean
                options?: unknown
                filters?: unknown
                _includeEventsSet?: Set<string>
                _includeSchemaMap?: Map<string, unknown>
                eventNames?(): Array<string | symbol>
                listenerCount?(name: string): number
                connection?: { state?: string; threadId?: number }
                ctrlConnection?: { state?: string; threadId?: number }
              }
            }
            const reader = service.reader
            return reader === undefined ? undefined : {
              ready: reader.ready,
              stopped: reader.stopped,
              starting: reader._starting,
              options: reader.options,
              filters: reader.filters,
              includeEvents: [...reader._includeEventsSet ?? []],
              includeSchema: [...reader._includeSchemaMap ?? []].map(([database, tables]) => [
                database,
                tables instanceof Set ? [...tables] : tables,
              ]),
              listeners: reader.eventNames?.().map(name => [String(name), reader.listenerCount?.(String(name))]),
              connection: reader.connection === undefined || reader.connection === null
                ? null
                : { state: reader.connection.state, threadId: reader.connection.threadId },
              ctrlConnection: reader.ctrlConnection === undefined || reader.ctrlConnection === null
                ? null
                : { state: reader.ctrlConnection.state, threadId: reader.ctrlConnection.threadId },
            }
          })(),
        },
        checkpoint,
        events: events.length,
      }, null, 2))
      throw cause
    }
    const beforeRotate = JSON.parse(await readFile(checkpointFile, 'utf8')) as { file: string }
    await writer.query('FLUSH BINARY LOGS')
    await waitFor('the rotated binlog checkpoint', async () => {
      const current = JSON.parse(await readFile(checkpointFile, 'utf8')) as { file: string }
      return current.file !== beforeRotate.file
    })

    await producer.dispose()
    producer = await ctx.plugin(CdcService, producerConfig)
    await writer.query(`
      INSERT INTO users VALUES
        (4, 'Restarted', 'restart@example.test', 'remove-after-restart', '2026-08-20 10:03:00.000')
    `)
    await writer.query(`
      INSERT INTO orders VALUES
        (202, 4, 7.5000, 'created', '2026-08-20 10:03:01.000')
    `)
    await waitFor('the two post-restart Kafka events', async () => events.length === 11)

    await waitFor('Redis projections', async () => ctx.redis.withClient(async (client) => {
      const userKeys = (await client.keys(`${redisUsersPrefix}:*`))
        .filter(key => !key.endsWith(':__dsh_cdc_version'))
      const orderKeys = (await client.keys(`${redisOrdersPrefix}:*`))
        .filter(key => !key.endsWith(':__dsh_cdc_version'))
      if (userKeys.length !== 2 || orderKeys.length !== 2) return false
      const users = await Promise.all(userKeys.map(key => client.get(key)))
      const orders = await Promise.all(orderKeys.map(key => client.get(key)))
      return users.some(value => value?.includes('Ada Updated') === true)
        && users.some(value => value?.includes('Restarted') === true)
        && users.every(value => value?.includes('secret_note') === false)
        && users.every(value => value?.includes('not-projected@example.test') === false)
        && orders.some(value => value?.includes('42.3400') === true)
        && orders.some(value => value?.includes('7.5000') === true)
    }))

    let esUsers: Array<Record<string, unknown>> = []
    let esOrders: Array<Record<string, unknown>> = []
    await waitFor('Elasticsearch projections', async () => ctx.elasticsearch.operation(async (client) => {
      await client.indices.refresh({ index: `${usersIndex},${ordersIndex}` })
      const userResult = await client.search({ index: usersIndex, size: 10 })
      const orderResult = await client.search({ index: ordersIndex, size: 10 })
      esUsers = userResult.hits.hits.map(hit => hit._source as Record<string, unknown>)
      esOrders = orderResult.hits.hits.map(hit => hit._source as Record<string, unknown>)
      return esUsers.length === 2 && esOrders.length === 2
        && esUsers.some(user => user.name === 'Ada Updated')
        && esUsers.some(user => user.name === 'Restarted')
        && esOrders.some(order => order.amount === '42.3400')
        && esOrders.some(order => order.amount === '7.5000')
    }))

    assert.deepEqual(
      events.reduce<Record<string, number>>((counts, event) => {
        counts[event.operation] = (counts[event.operation] ?? 0) + 1
        return counts
      }, {}),
      { insert: 6, update: 3, delete: 2 },
    )
    assert.equal(new Set(events.map(event => event.eventId)).size, 11)
    assert.equal(events.filter(event => event.source.table === 'users').length, 6)
    assert.equal(events.filter(event => event.source.table === 'orders').length, 5)
    assert.equal(events.some(event => JSON.stringify(event).includes('Historical')), false)
    assert.equal(events.every(event => (
      !Object.hasOwn(event.before ?? {}, 'secret_note')
      && !Object.hasOwn(event.after ?? {}, 'secret_note')
    )), true)
    assert.deepEqual(
      events.find(event => event.operation === 'update' && event.after?.email === 'not-projected@example.test')?.changedColumns,
      ['email'],
    )
    assert.deepEqual(
      events.find(event => event.operation === 'update' && event.after?.name === 'Ada Updated')?.changedColumns,
      ['name', 'secret_note'],
    )
    assert.equal(esUsers.some(user => user.name === 'Ada Updated'), true)
    assert.equal(esUsers.some(user => user.name === 'Restarted'), true)
    assert.equal(esUsers.every(user => !('secret_note' in user)), true)
    assert.equal(esUsers.some(user => user.email === 'not-projected@example.test'), false)
    assert.equal(esOrders.some(order => order.amount === '42.3400'), true)
    assert.equal(esOrders.some(order => order.amount === '7.5000'), true)

    const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8')) as {
      file: string
      position: number
      schemas: Record<string, string>
    }
    console.log(JSON.stringify({
      events: events.length,
      operations: { insert: 6, update: 3, delete: 2 },
      topics: { [usersTopic]: 6, [ordersTopic]: 5 },
      redis: { users: 2, orders: 2 },
      elasticsearch: { users: esUsers.length, orders: esOrders.length },
      checkpoint,
      rotation: { from: beforeRotate.file, to: checkpoint.file },
      historicalRowsPublished: false,
      excludedColumnPublished: false,
      unwatchedEmailProjected: false,
    }, null, 2))
    await producer.dispose()
    await ctx.elasticsearch.operation(async (client) => {
      await client.indices.delete({ index: testIndices, ignore_unavailable: true }, { ignore: [404] })
    })
    testIndicesDeleted = true
  } finally {
    if (elasticsearchReady && !testIndicesDeleted) {
      try {
        await ctx.elasticsearch.operation(async (client) => {
          await client.indices.delete({ index: testIndices, ignore_unavailable: true }, { ignore: [404] })
        })
      } catch (cause) {
        console.warn('live smoke could not clean Elasticsearch test indices', cause)
      }
    }
    await writer.end()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

await main()
