import { randomInt, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CdcService from '@deepseek-ai/dsh-cdc'
import { decodeCdcEvent, encodeKey, type CdcCheckpoint, type CdcEvent } from '@deepseek-ai/dsh-cdc-protocol'
import {
  agentRecordId,
  conversationId,
  conversationMessageId,
  conversationSessionId,
  conversationTenantId,
  conversationUserId,
  type AgentRecord,
} from '@deepseek-ai/dsh-conversation'
import ConversationMysql from '@deepseek-ai/dsh-conversation-mysql'
import KafkaService, {
  KafkaConsumerGroupId,
  KafkaSubscriptionId,
  KafkaTopic,
} from '@deepseek-ai/dsh-kafka'
import Mysql from '@deepseek-ai/dsh-mysql'
import { Admin } from '@platformatic/kafka'
import type { RowDataPacket } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'

const enabled = process.env.DSH_CONVERSATION_CDC_E2E === '1'
const mysqlHost = process.env.DSH_CDC_MYSQL_HOST ?? '127.0.0.1'
const mysqlPort = Number(process.env.DSH_CDC_MYSQL_PORT ?? '13306')
const mysqlDatabase = 'dsh_cdc_test'
const mysqlCdcUser = process.env.DSH_CDC_MYSQL_CDC_USER ?? 'dsh_cdc'
const mysqlCdcPassword = process.env.DSH_CDC_MYSQL_CDC_PASSWORD ?? 'dsh_cdc_test'
const mysqlWriterUser = process.env.DSH_CDC_MYSQL_WRITER_USER ?? 'root'
const mysqlWriterPassword = process.env.DSH_CDC_MYSQL_WRITER_PASSWORD ?? 'dsh_cdc_root_test'
const kafkaBroker = process.env.DSH_CDC_KAFKA_BROKER ?? '127.0.0.1:19092'

const MESSAGE_COLUMNS = [
  'tenant_id',
  'user_id',
  'session_id',
  'message_id',
  'revision',
  'status',
  'visibility',
  'role',
  'visible_text',
  'occurred_at',
] as const
const MESSAGE_SCHEMA_FINGERPRINT = '0247d90d50bf13efeb45c196e019a5f8eee69c43649df10cf83dacdba6eacb8a'

interface CapturedEvent {
  event: CdcEvent
  key: Buffer
}

async function waitFor(
  description: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (cause) {
      lastError = cause
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`conversation CDC E2E timed out waiting for ${description}`, { cause: lastError })
}

function canonicalIsoUtc(value: unknown): boolean {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value
}

function recordsFor(
  identity: {
    tenantId: ReturnType<typeof conversationTenantId>
    userId: ReturnType<typeof conversationUserId>
    conversationId: ReturnType<typeof conversationId>
  },
  runId: string,
  start: number,
  count: number,
): AgentRecord[] {
  return Array.from({ length: count }, (_, offset): AgentRecord => {
    const sequence = start + offset
    return {
      ...identity,
      recordId: agentRecordId(`${runId}-record-${String(sequence)}`),
      sequence,
      sourceSequence: sequence,
      type: 'user/message',
      status: 'completed',
      payload: {
        messageId: conversationMessageId(`${runId}-message-${String(sequence)}`),
        text: `semantic message ${String(sequence)}`,
      },
      occurredAt: Date.UTC(2026, 7, 25, 0, 0, 0, sequence),
      extensions: {},
    }
  })
}

describe.skipIf(!enabled)('ConversationMysql to Kafka CDC', () => {
  it('publishes 300 complete semantic messages exactly once across a checkpoint restart', async () => {
    const runId = randomUUID()
    const topic = `dsh.conversation.cdc.e2e.${runId}`
    const group = `dsh-conversation-cdc-e2e-${runId}`
    const directory = await mkdtemp(join(tmpdir(), 'dsh-conversation-cdc-e2e-'))
    const checkpointFile = join(directory, 'checkpoint.json')
    const ctx = new Context()
    const admin = new Admin({
      bootstrapBrokers: [kafkaBroker],
      clientId: `dsh-conversation-cdc-admin-${runId}`,
      connectTimeout: 5_000,
      timeout: 10_000,
      retries: 3,
      retryDelay: 200,
      strict: true,
    })
    const captured: CapturedEvent[] = []
    const identity = {
      tenantId: conversationTenantId(`cdc-tenant-${runId}`),
      userId: conversationUserId(`cdc-user-${runId}`),
      conversationId: conversationId(`cdc-conversation-${runId}`),
    }
    const sessionId = conversationSessionId(`cdc-session-${runId}`)
    const producerConfig = {
      host: mysqlHost,
      port: mysqlPort,
      user: mysqlCdcUser,
      password: mysqlCdcPassword,
      serverId: randomInt(100_000, 2_000_000_000),
      connectTimeoutMs: 5_000,
      checkpointFile,
      routes: [{
        database: mysqlDatabase,
        table: 'dsh_conversation_messages',
        topic,
        primaryKey: ['tenant_id', 'user_id', 'session_id', 'message_id'],
      }],
      maxEventBytes: 1_048_576,
      maxBinlogEventBytes: 67_108_864,
      maxQueueBytes: 16_777_216,
      retryInitialDelayMs: 200,
      retryMaxDelayMs: 2_000,
      maxRetries: 5,
    } as const
    let topicCreated = false
    let mysqlMounted = false

    try {
      await admin.createTopics({ topics: [topic], partitions: 1, replicas: 1 })
      topicCreated = true
      await ctx.plugin(Mysql, {
        host: mysqlHost,
        port: mysqlPort,
        user: mysqlWriterUser,
        password: mysqlWriterPassword,
        database: mysqlDatabase,
        connectionLimit: 4,
      })
      mysqlMounted = true
      await ctx.plugin(ConversationMysql)
      await ctx.plugin(KafkaService, {
        binding: `conversation-cdc-${runId}`,
        brokers: [kafkaBroker],
        clientId: `dsh-conversation-cdc-${runId}`,
        tls: false,
        requestTimeoutMs: 10_000,
        connectionTimeoutMs: 5_000,
        retries: 3,
        retryDelayMs: 200,
        topics: [topic],
        consumerGroups: [group],
        consumerHighWaterMark: 64,
      })

      const columns = await ctx.mysql.connection(async (connection) => {
        const [rows] = await connection.query<(RowDataPacket & { column_name: string })[]>(
          `SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dsh_conversation_messages'
           ORDER BY ORDINAL_POSITION`,
        )
        return rows.map(row => row.column_name)
      })
      expect(columns).toEqual(MESSAGE_COLUMNS)

      await ctx.kafka.subscribe({
        id: KafkaSubscriptionId(`capture-${runId}`),
        groupId: KafkaConsumerGroupId(group),
        topics: [KafkaTopic(topic)],
        fallbackMode: 'earliest',
        handle(message) {
          expect(message.key).not.toBeNull()
          expect(message.value).not.toBeNull()
          captured.push({
            key: Buffer.from(message.key!),
            event: decodeCdcEvent(message.value!),
          })
        },
      })
      let producer = await ctx.plugin(CdcService, producerConfig)

      await ctx.conversations.create({
        ...identity,
        sessionId,
        origin: 'top-level',
        delegationDepth: 0,
      })
      await ctx.conversations.append({
        ...identity,
        expectedNextSequence: 1,
        records: recordsFor(identity, runId, 1, 150),
      })
      await waitFor('the first 150 Kafka events', () => captured.length >= 150)

      await producer.dispose()
      const firstCheckpoint = JSON.parse(await readFile(checkpointFile, 'utf8')) as CdcCheckpoint
      const tableId = `${mysqlDatabase}.dsh_conversation_messages`
      expect(firstCheckpoint.file).toMatch(/^\S+$/u)
      expect(firstCheckpoint.position).toBeGreaterThan(4)
      expect(firstCheckpoint.schemas[tableId]).toBe(MESSAGE_SCHEMA_FINGERPRINT)

      producer = await ctx.plugin(CdcService, producerConfig)
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(captured).toHaveLength(150)

      await ctx.conversations.append({
        ...identity,
        expectedNextSequence: 151,
        records: recordsFor(identity, runId, 151, 150),
      })
      await waitFor('all 300 Kafka events', () => captured.length >= 300)
      await producer.dispose()

      expect(captured).toHaveLength(300)
      expect(new Set(captured.map(item => item.event.eventId)).size).toBe(300)
      expect(new Set(captured.map(item => item.event.schemaFingerprint))).toEqual(
        new Set([firstCheckpoint.schemas[tableId]]),
      )
      const finalCheckpoint = JSON.parse(await readFile(checkpointFile, 'utf8')) as CdcCheckpoint
      expect(finalCheckpoint.schemas[tableId]).toBe(firstCheckpoint.schemas[tableId])

      for (const [index, item] of captured.entries()) {
        const sequence = index + 1
        const expectedKey = {
          tenant_id: identity.tenantId,
          user_id: identity.userId,
          session_id: sessionId,
          message_id: conversationMessageId(`${runId}-message-${String(sequence)}`),
        }
        expect(item.event.operation).toBe('insert')
        expect(item.event.source).toMatchObject({ database: mysqlDatabase, table: 'dsh_conversation_messages' })
        expect(item.event.key).toEqual(expectedKey)
        expect(item.key.equals(encodeKey(expectedKey))).toBe(true)
        expect(item.key.toString('utf8')).toBe(JSON.stringify(expectedKey))
        expect(item.event.before).toBeNull()
        expect(Object.keys(item.event.after ?? {})).toEqual(MESSAGE_COLUMNS)
        expect(item.event.after).toMatchObject({
          ...expectedKey,
          revision: 1,
          status: 'completed',
          visibility: 'user',
          role: 'user',
          visible_text: `semantic message ${String(sequence)}`,
        })
        expect(canonicalIsoUtc(item.event.occurredAt)).toBe(true)
        expect(canonicalIsoUtc(item.event.after?.occurred_at)).toBe(true)
      }
      expect(JSON.stringify(captured)).not.toContain('chunk')

    } finally {
      if (mysqlMounted) {
        await ctx.mysql.connection(async (connection) => {
          await connection.query('DELETE FROM dsh_conversation_message_state WHERE tenant_id = ?', [identity.tenantId])
          await connection.query('DELETE FROM dsh_conversation_messages WHERE tenant_id = ?', [identity.tenantId])
          await connection.query('DELETE FROM dsh_subagent_runs WHERE tenant_id = ?', [identity.tenantId])
          await connection.query('DELETE FROM dsh_agent_records WHERE tenant_id = ?', [identity.tenantId])
          await connection.query('DELETE FROM dsh_conversations WHERE tenant_id = ?', [identity.tenantId])
        }).catch(() => undefined)
      }
      await ctx.fiber.dispose().catch(() => undefined)
      if (topicCreated) await admin.deleteTopics({ topics: [topic] }).catch(() => undefined)
      await admin.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
