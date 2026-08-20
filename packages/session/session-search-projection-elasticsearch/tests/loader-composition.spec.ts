/**
 * REAL-composition proof: a test-only YAML tree boots through the vendored
 * Loader, the function plugin's namespace survives, and a fixed encoded event
 * indexes through the real package entry.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SessionSearchProjection from '@deepseek-ai/dsh-session-search-projection-elasticsearch'
import {
  documentId,
  FakeElasticsearch,
  FakeKafka,
  FakeSource,
  INDEX,
  kafkaMessage,
  PLUGIN_CONFIG,
} from './harness.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('loads the shipped YAML shape and indexes one fixed upsert', async () => {
    const kafka = new FakeKafka()
    const elasticsearch = new FakeElasticsearch()
    const source = new FakeSource()
    root = await mkdtemp(join(tmpdir(), 'dsh-session-search-projection-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: test:kafka',
      '- name: test:elasticsearch',
      '- name: test:source',
      "- name: '@deepseek-ai/dsh-session-search-projection-elasticsearch'",
      '  config:',
      `    topic: ${PLUGIN_CONFIG.topic}`,
      `    groupId: ${PLUGIN_CONFIG.groupId}`,
      `    maxBytes: ${String(PLUGIN_CONFIG.maxBytes)}`,
      `    index: ${PLUGIN_CONFIG.index}`,
      `    mode: ${PLUGIN_CONFIG.mode}`,
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['test:kafka', { name: 'test-kafka', apply: (ctx: Context) => { ctx.provide('kafka', kafka) } }],
      ['test:elasticsearch', {
        name: 'test-elasticsearch',
        apply: (ctx: Context) => { ctx.provide('elasticsearch', elasticsearch) },
      }],
      ['test:source', {
        name: 'test-source',
        apply: (ctx: Context) => { ctx.provide('sessionCompleteMessageQuery', source) },
      }],
      ['@deepseek-ai/dsh-session-search-projection-elasticsearch', SessionSearchProjection],
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

    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    await kafka.deliver(kafkaMessage())
    expect(elasticsearch.writes[0]).toMatchObject({
      index: INDEX,
      id: documentId('user-8', 'message-12'),
      version: 13,
      document: { content: 'hello from the source', deleted: false },
    })
    expect(kafka.committed).toBe(1)
  })

  it('keeps the function-plugin namespace free of a default export', () => {
    expect('default' in SessionSearchProjection).toBe(false)
  })
})
