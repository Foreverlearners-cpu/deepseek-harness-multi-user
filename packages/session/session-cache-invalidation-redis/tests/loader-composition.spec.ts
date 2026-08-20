/**
 * REAL-composition proof: a test-only YAML tree boots through the vendored
 * Loader, the function plugin's namespace survives, and one upsert deletes
 * the derived Redis key after the awaited handler succeeds.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { KafkaTopic } from '@deepseek-ai/dsh-kafka'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  encodeSessionMessageChange,
  SESSION_MESSAGE_CHANGE_EVENT_TYPE,
  SESSION_MESSAGE_CHANGE_SCHEMA_VERSION,
  SessionMessageChangeEventId,
  SessionMessageChangeUserId,
} from '@deepseek-ai/dsh-session-message-change-protocol'
import * as SessionCacheInvalidationRedis from '../src/index.ts'
import { sessionContextCacheKey } from '../src/index.ts'
import { FakeKafka, FakeRedis } from './fakes.ts'

const CONFIG_LINES = [
  "- name: '@deepseek-ai/dsh-kafka'",
  "- name: '@deepseek-ai/dsh-redis'",
  "- name: '@deepseek-ai/dsh-session-cache-invalidation-redis'",
  '  config:',
  '    topic: dsh.session.message-changes',
  '    groupId: dsh-session-context-cache',
  '    subscriptionId: session-context-cache',
  '    mode: committed',
  '    maxBytes: 4096',
  '    deploymentId: deploy-a',
] as const

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-cache-invalidation-redis-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...CONFIG_LINES, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-kafka', FakeKafka],
    ['@deepseek-ai/dsh-redis', FakeRedis],
    ['@deepseek-ai/dsh-session-cache-invalidation-redis', SessionCacheInvalidationRedis],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the consumer YAML shape and deletes the derived cache key', async () => {
    const loaded = await loadYaml()

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const kafka = loaded.kafka as unknown as FakeKafka
    const redis = loaded.redis as unknown as FakeRedis
    const userId = SessionMessageChangeUserId('user-8')
    const sessionId = SessionId('session-100')
    const key = sessionContextCacheKey({
      deploymentId: 'deploy-a',
      userId,
      sessionId,
    })
    redis.keys.add(key)

    await kafka.deliver({
      topic: KafkaTopic('dsh.session.message-changes'),
      partition: 0,
      offset: 3n,
      timestamp: 1n,
      key: null,
      value: Buffer.from(encodeSessionMessageChange({
        schemaVersion: SESSION_MESSAGE_CHANGE_SCHEMA_VERSION,
        eventId: SessionMessageChangeEventId('evt-composed'),
        eventType: SESSION_MESSAGE_CHANGE_EVENT_TYPE,
        userId,
        sessionId,
        messageId: MessageId('message-12'),
        operation: 'upsert',
        sourceSeq: 12,
        occurredAt: '2026-08-19T13:49:00.000Z',
      }, { maxBytes: 4096 })),
      headers: [],
    })

    expect(redis.deleted).toEqual([key])
    expect(kafka.committed).toEqual([{
      topic: 'dsh.session.message-changes',
      partition: 0,
      offset: 3n,
    }])
  })

  it('keeps the function-plugin namespace free of a default export', () => {
    expect('default' in SessionCacheInvalidationRedis).toBe(false)
  })
})
