import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import ConversationPersistence from '../../conversation-persistence/src/index.ts'
import ConversationStarter, { stableSessionIdentity } from '../../conversation-starter/src/index.ts'
import { MemoryConversationService } from '../../conversation-starter/tests/memory-provider.ts'
import ConversationWeb from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-conversation-web-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@fixture/conversation-provider'",
    "- name: '@deepseek-ai/dsh-conversation-persistence'",
    "- name: '@deepseek-ai/dsh-conversation-starter'",
    '  config:',
    '    tenantId: loader-tenant',
    '    localUserId: loader-user',
    "- name: '@deepseek-ai/dsh-conversation-web'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@fixture/conversation-provider', MemoryConversationService],
    ['@deepseek-ai/dsh-conversation-persistence', ConversationPersistence],
    ['@deepseek-ai/dsh-conversation-starter', ConversationStarter],
    ['@deepseek-ai/dsh-conversation-web', ConversationWeb],
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

describe('Conversation Web Loader composition', () => {
  it('loads the complete lifecycle chain and attaches a Session', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const id = SessionId('loader-web-session')
    const session = ctx.sessions.create(id)
    const agent = { id, session } as Agent
    await ctx.conversationWeb.attach(ctx.extend({ agent }))
    expect((ctx.conversations as MemoryConversationService).bySession.get(stableSessionIdentity(id).sessionId))
      .toMatchObject({ tenantId: 'loader-tenant', userId: 'loader-user' })
  })
})
