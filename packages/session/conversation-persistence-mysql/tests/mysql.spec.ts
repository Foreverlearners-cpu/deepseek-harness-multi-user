import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import Mysql from '@deepseek-ai/dsh-mysql'
import FileStorageService from '@deepseek-ai/dsh-file-storage'
import MysqlUserService from '../../../identity/user-mysql/src/index.ts'
import MysqlConversationPersistence, { MysqlRuntimeConfigStore } from '../src/index.ts'
import MysqlConversationSessionPersistence from '../src/session-persistence.ts'
import type { Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'

const target = process.env.DSH_MYSQL_TEST_URL
let ctx: Context | undefined
const testRoots: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  await Promise.all(testRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  ctx = undefined
})

function targetConfig(): MysqlConfig {
  const url = new URL(target!)
  return {
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectionLimit: 2,
  }
}

async function boot(): Promise<{ store: MysqlConversationPersistence; userId: string }> {
  const userId = `conversation-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Mysql, targetConfig())
  await ctx.plugin(MysqlUserService, { bootstrapUserId: userId })
  await ctx.plugin(MysqlRuntimeConfigStore)
  const fileRoot = await mkdtemp(join(tmpdir(), 'dsh-conversation-test-'))
  testRoots.push(fileRoot)
  await ctx.plugin(FileStorageService, { root: fileRoot })
  await ctx.plugin(MysqlConversationPersistence, { userId })
  return { store: ctx.conversationPersistence, userId }
}

describe.skipIf(target === undefined)('message-only MySQL conversation persistence', () => {
  it('persists one turn without chunk rows, titles, JSON, and files', async () => {
    const { store, userId } = await boot()
    const sessionId = `conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await store.createConversation({ sessionId, extensions: { 'ui:example': { pinned: true } } })
    const files = await store.saveFile(sessionId, {
      originalName: 'hello.txt', mediaType: 'text/plain', data: Buffer.from('hello'),
    })
    const messages = await store.appendMessages(sessionId, [
      { eventType: 'user/message', role: 'user', content: [{ type: 'text', text: 'hello' }], fileIds: [files.fileId] },
      { eventType: 'tool/result', role: 'tool', toolCallId: 'call-1', content: { ok: true }, visibility: 'internal' },
      { eventType: 'assistant/message', role: 'assistant', content: [{ type: 'text', text: 'world' }], usage: { total: 2 } },
    ])
    await store.updateTitle(sessionId, 'Hello', 'generated', 'provider')
    await store.updateExtensions(sessionId, { 'ui:example': { pinned: false }, 'app:version': 1 })
    const loaded = await store.getConversation(sessionId)
    expect(loaded?.title).toBe('Hello')
    expect(loaded?.extensions).toMatchObject({ 'app:version': 1 })
    expect((await store.readMessages(sessionId)).map(message => message.eventType)).toEqual([
      'user/message', 'tool/result', 'assistant/message',
    ])
    expect((await store.readMessages(sessionId)).every(message => message.userId === userId)).toBe(true)
    expect((await store.listMessageFiles(sessionId, messages[0]!.messageId))[0]?.fileId).toBe(files.fileId)
    await expect(store.readFile(sessionId, files.fileId)).resolves.toMatchObject({ data: Buffer.from('hello') })
    const hydrated = await store.hydrate(sessionId)
    expect(hydrated?.events.some(event => event.type === 'assistant/chunk')).toBe(false)
    expect(hydrated?.events.map((event, index) => event.seq === index)).not.toContain(false)
    const restored = Session.fromRestore(sessionId as never, hydrated!.events, hydrated!.meta)
    expect(restored.events.every((event, index) => event.seq === index)).toBe(true)
  })

  it('keeps dynamic config in MySQL', async () => {
    const { store } = await boot()
    const configKey = `session-title.maxTitleBytes.${Date.now()}`
    await ctx!.runtimeConfigs.set({ key: configKey, value: 128, valueType: 'number' })
    await expect(ctx!.runtimeConfigs.get(configKey)).resolves.toMatchObject({ value: 128, revision: 0 })
    await expect(store.getConversation('not-owned')).resolves.toBeUndefined()
  })

  it('uses the dynamic conversation default title without blocking title derivation after restore', async () => {
    const { store } = await boot()
    await ctx!.runtimeConfigs.set({
      key: 'conversation.default_title', value: '可配置会话', valueType: 'string',
    })
    const sessionId = `dynamic-title-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const created = await store.createConversation({ sessionId })
    expect(created.title).toBe('可配置会话')
    expect(created.titleStatus).toBe('fallback')
    expect(created.titleSource).toBe('config')

    const hydrated = await store.hydrate(sessionId)
    expect(hydrated?.events.some(event => event.type === 'session/title')).toBe(false)

    await store.appendMessage(sessionId, {
      eventType: 'user/message', role: 'user',
      content: [{ type: 'text', text: '根据第一条消息生成标题' }],
    })
    await store.updateTitle(sessionId, '第一条消息生成的标题', 'fallback', 'fallback')
    const updated = await store.getConversation(sessionId)
    expect(updated?.title).toBe('第一条消息生成的标题')
    expect(updated?.titleSource).toBe('fallback')
  })

  it('projects only final surface events at turn end', async () => {
    const { store, userId } = await boot()
    const sessionId = `event-conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const session = ctx!.sessions.create(sessionId as never, { meta: { userId: userId as never } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      ...createUserMessage({ content: [{ type: 'text', text: 'persist me' }], source: { kind: 'user' } }),
    }, { surfaceOp: 'append' })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'ignored' } })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'stored' }], source: { provider: 'test', model: 'test' } }),
      usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 100))
    const messages = await store.readMessages(sessionId)
    expect(messages.map(message => message.eventType)).toEqual(['user/message', 'assistant/message'])
    expect(JSON.stringify(messages)).not.toContain('ignored')
    await expect(store.readOutbox({ limit: 10 })).resolves.toHaveLength(2)
    await expect(store.listAttempts(sessionId)).resolves.toHaveLength(1)
  })

  it('does not skip outbox rows committed in the same millisecond', async () => {
    const { store } = await boot()
    const sessionId = `outbox-cursor-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await store.createConversation({ sessionId })
    const messages = await store.appendMessages(sessionId, [
      { eventType: 'user/message', role: 'user', content: [{ type: 'text', text: 'one' }] },
      { eventType: 'assistant/message', role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { eventType: 'assistant/message', role: 'assistant', content: [{ type: 'text', text: 'three' }] },
    ])
    const first = await store.readOutbox({ afterSequence: -1, limit: 1 })
    expect(first).toHaveLength(1)
    expect(first[0]!.outboxSequence).toBeDefined()
    const rest = await store.readOutbox({ afterSequence: first[0]!.outboxSequence!, limit: 10 })
    const expected = messages.filter(message => message.messageId !== first[0]!.messageId)
    expect(new Set(rest.map(event => event.messageId))).toEqual(new Set(expected.map(message => message.messageId)))
  })

  it('exposes message-only rows through the SessionPersistence resume contract', async () => {
    const { store } = await boot()
    const sessionId = `resume-conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await store.createConversation({ sessionId, title: 'Resume me' })
    await store.appendMessages(sessionId, [
      { eventType: 'user/message', role: 'user', content: [{ type: 'text', text: 'question' }] },
      { eventType: 'assistant/message', role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ])
    await ctx!.plugin(MysqlConversationSessionPersistence)
    const loaded = await ctx!.sessionPersistence.inspect(sessionId as never)
    expect(loaded.events.some(event => event.type === 'assistant/chunk')).toBe(false)
    expect(loaded.events.map((event, index) => event.seq === index)).not.toContain(false)
  })
})
