import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import {
  FileObjectId,
  FileObjectSha256,
  FileStorageKey,
  type FileObjectRef,
} from '@deepseek-ai/dsh-file-storage'
import { afterEach, describe, expect, it } from 'vitest'
import LocalFileStorage, { LOCAL_FILE_STORAGE_BACKEND } from '../src/index.ts'
import * as InvariantCompanion from '../src/invariant.ts'
import { runFileStorageContract } from '../../file-storage/tests/contract.ts'

const roots: string[] = []

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-storage-local-'))
  roots.push(root)
  return root
}

async function * chunks(...values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Uint8Array[] = []
  for await (const value of content) values.push(value)
  return Buffer.concat(values)
}

function missingRef(): FileObjectRef {
  const digest = 'f'.repeat(64)
  return {
    objectId: FileObjectId(`sha256:${digest}`),
    storageBackend: LOCAL_FILE_STORAGE_BACKEND,
    storageKey: FileStorageKey(`objects/sha256/ff/ff/${digest}`),
    sha256: FileObjectSha256(digest),
    byteSize: 1,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

runFileStorageContract('local filesystem', async () => ({
  storage: new LocalFileStorage(new Context(), { root: await freshRoot() }),
  missingRef: missingRef(),
}))

describe('local file storage durability', () => {
  it('deduplicates concurrent publishers and leaves no staging files', async () => {
    const root = await freshRoot()
    const storage = new LocalFileStorage(new Context(), { root })
    const bytes = Buffer.from('one immutable object')
    const refs = await Promise.all(Array.from({ length: 16 }, () =>
      storage.put({ content: chunks(bytes) })))

    expect(refs.every(ref => JSON.stringify(ref) === JSON.stringify(refs[0]))).toBe(true)
    expect(await readdir(join(root, '.staging'))).toEqual([])
    const key = String(refs[0]!.storageKey)
    expect(isAbsolute(key)).toBe(false)
    expect(await readFile(join(root, ...key.split('/')))).toEqual(bytes)
  })

  it('opens a durable reference after constructing a new provider', async () => {
    const root = await freshRoot()
    const first = new LocalFileStorage(new Context(), { root })
    const ref = await first.put({ content: chunks(Buffer.from('survives restart')) })
    const restarted = new LocalFileStorage(new Context(), { root })

    await expect(restarted.open(structuredClone(ref)).then(collect))
      .resolves.toEqual(Buffer.from('survives restart'))
    await expect(restarted.stat(structuredClone(ref))).resolves.toEqual({ status: 'ready', ref })
  })

  it('streams an object across write and read buffer boundaries', async () => {
    const root = await freshRoot()
    const storage = new LocalFileStorage(new Context(), { root })
    const parts = [Buffer.alloc(33_000, 1), Buffer.alloc(67_000, 2), Buffer.alloc(5, 3)]
    const expected = Buffer.concat(parts)
    const ref = await storage.put({ content: chunks(...parts) })

    expect(ref).toMatchObject({
      byteSize: expected.byteLength,
      sha256: createHash('sha256').update(expected).digest('hex'),
    })
    await expect(storage.open(ref).then(collect)).resolves.toEqual(expected)
  })

  it('detects same-length content corruption while streaming an open object', async () => {
    const root = await freshRoot()
    const storage = new LocalFileStorage(new Context(), { root })
    const ref = await storage.put({ content: chunks(Buffer.from('original')) })
    await writeFile(join(root, ...String(ref.storageKey).split('/')), Buffer.from('tampered'))

    await expect(storage.open(ref).then(collect))
      .rejects.toMatchObject({ code: 'corrupt', operation: 'open' })
  })

  it('rejects a size-corrupt object from stat', async () => {
    const root = await freshRoot()
    const storage = new LocalFileStorage(new Context(), { root })
    const ref = await storage.put({ content: chunks(Buffer.from('original')) })
    await writeFile(join(root, ...String(ref.storageKey).split('/')), Buffer.from('short'))

    await expect(storage.stat(ref)).rejects.toMatchObject({ code: 'corrupt', operation: 'stat' })
  })

  it.each([
    [(ref: FileObjectRef) => ({ ...ref, objectId: FileObjectId('sha256:wrong') }), 'invalid-reference'],
    [(ref: FileObjectRef) => ({ ...ref, storageKey: FileStorageKey('../escape') }), 'invalid-reference'],
    [(ref: FileObjectRef) => ({ ...ref, sha256: FileObjectSha256('0'.repeat(64)) }), 'invalid-reference'],
    [(ref: FileObjectRef) => ({ ...ref, byteSize: ref.byteSize + 1 }), 'corrupt'],
  ] as const)('rejects a tampered reference', async (tamper, code) => {
    const root = await freshRoot()
    const storage = new LocalFileStorage(new Context(), { root })
    const ref = await storage.put({ content: chunks(Buffer.from('bound fields')) })

    await expect(storage.open(tamper(ref))).rejects.toMatchObject({ code })
  })

  it('cancels a stalled source and removes its staging file', async () => {
    const root = await freshRoot()
    const storage = new LocalFileStorage(new Context(), { root })
    const controller = new AbortController()
    let release: (() => void) | undefined
    async function * stalled(): AsyncIterable<Uint8Array> {
      yield Buffer.from('partial')
      await new Promise<void>((resolveWait) => { release = resolveWait })
      yield Buffer.from('unreachable')
    }
    const writing = storage.put({ content: stalled() }, controller.signal)
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
    const reason = new Error('cancel local write')
    controller.abort(reason)

    await expect(writing).rejects.toBe(reason)
    release?.()
    expect(await readdir(join(root, '.staging'))).toEqual([])
  })

  it('classifies a filesystem setup failure without publishing a reference', async () => {
    const parent = await freshRoot()
    const root = join(parent, 'not-a-directory')
    await writeFile(root, 'occupied')
    const storage = new LocalFileStorage(new Context(), { root })

    await expect(storage.put({ content: chunks(Buffer.from('x')) }))
      .rejects.toMatchObject({ code: 'write-failed', operation: 'put' })
  })

  it('rejects a corrupt pre-existing digest target during deduplication', async () => {
    const root = await freshRoot()
    const storage = new LocalFileStorage(new Context(), { root })
    const bytes = Buffer.from('expected bytes')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const path = join(root, 'objects', 'sha256', digest.slice(0, 2), digest.slice(2, 4), digest)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from('corrupt bytes'))

    await expect(storage.put({ content: chunks(bytes) }))
      .rejects.toMatchObject({ code: 'corrupt', operation: 'put' })
  })
})

describe('local file storage invariant companion', () => {
  it('registers and releases package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(InvariantCompanion)
    await fiber.dispose()
    await ctx.plugin(InvariantCompanion)
  })
})
