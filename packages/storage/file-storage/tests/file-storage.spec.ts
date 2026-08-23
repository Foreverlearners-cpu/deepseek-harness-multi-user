import { readFile, rm, stat } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import FileStorageService from '../src/index.ts'
import * as InvariantCompanion from '../src/invariant.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-storage-'))
  roots.push(root)
  return root
}

describe('file storage service', () => {
  it('publishes content-addressed bytes and reads them back', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    const service = await ctx.plugin(FileStorageService, { root })
    const data = Buffer.from('hello')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const published = await ctx.fileStorage.put(data)
    expect(published).toMatchObject({ sha256, storageBackend: 'local', byteSize: 5 })
    expect(published.storageKey).toBe(`objects/${sha256.slice(0, 2)}/${sha256}`)
    await expect(ctx.fileStorage.get(published.storageKey, published.sha256)).resolves.toEqual(data)
    await expect(stat(join(root, published.storageKey))).resolves.toBeDefined()
    await service.dispose()
  })

  it('deduplicates identical content and checks expected digests', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(FileStorageService, { root })
    const first = await ctx.fileStorage.put(Buffer.from('same'))
    const second = await ctx.fileStorage.put(Buffer.from('same'), first.sha256.toUpperCase())
    expect(second).toEqual(first)
    await expect(ctx.fileStorage.put(Buffer.from('different'), first.sha256)).rejects.toThrow(/checksum/)
  })

  it('rejects path traversal and corrupted bytes', async () => {
    const root = await freshRoot()
    const ctx = new Context()
    await ctx.plugin(FileStorageService, { root })
    const data = Buffer.from('verified')
    const published = await ctx.fileStorage.put(data)
    await expect(ctx.fileStorage.get('../outside', published.sha256)).rejects.toThrow(/invalid file storage key/)
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(root, published.storageKey), 'tampered'))
    await expect(ctx.fileStorage.get(published.storageKey, published.sha256)).rejects.toThrow(/checksum/)
  })

  it('registers and releases the invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(InvariantCompanion)
    await fiber.dispose()
    await ctx.plugin(InvariantCompanion)
  })

  it('does not materialize a root until a write', async () => {
    const root = join(await freshRoot(), 'nested')
    const ctx = new Context()
    await ctx.plugin(FileStorageService, { root })
    await expect(readFile(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
