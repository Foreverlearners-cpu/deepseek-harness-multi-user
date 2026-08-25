import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import FileStorage, {
  FileObjectId,
  FileObjectSha256,
  FileStorageBackend,
  FileStorageError,
  FileStorageKey,
  type FileObjectContent,
  type FileObjectRef,
  type FileObjectStat,
  type PutFileObjectRequest,
} from '../src/index.ts'
import * as InvariantCompanion from '../src/invariant.ts'
import { runFileStorageContract } from './contract.ts'

const BACKEND = FileStorageBackend('memory')

async function consume(content: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of content) {
    signal?.throwIfAborted()
    chunks.push(Uint8Array.from(chunk))
  }
  signal?.throwIfAborted()
  return Buffer.concat(chunks)
}

class MemoryFileStorage extends FileStorage {
  readonly storageBackend = BACKEND
  private readonly objects = new Map<string, { ref: FileObjectRef; bytes: Buffer }>()

  async put(request: PutFileObjectRequest, signal?: AbortSignal): Promise<FileObjectRef> {
    signal?.throwIfAborted()
    const bytes = await consume(request.content, signal)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (request.expectedSha256 !== undefined && request.expectedSha256 !== digest) {
      throw new FileStorageError('checksum-mismatch', 'put')
    }
    if (request.expectedByteSize !== undefined && request.expectedByteSize !== bytes.byteLength) {
      throw new FileStorageError('size-mismatch', 'put')
    }
    const existing = this.objects.get(digest)
    if (existing !== undefined) return structuredClone(existing.ref)
    const ref: FileObjectRef = {
      objectId: FileObjectId(`sha256:${digest}`),
      storageBackend: this.storageBackend,
      storageKey: FileStorageKey(`objects/${digest.slice(0, 2)}/${digest}`),
      sha256: FileObjectSha256(digest),
      byteSize: bytes.byteLength,
    }
    this.objects.set(digest, { ref: structuredClone(ref), bytes: Buffer.from(bytes) })
    return ref
  }

  async open(ref: FileObjectRef, signal?: AbortSignal): Promise<FileObjectContent> {
    signal?.throwIfAborted()
    const object = this.resolve(ref, 'open')
    const bytes = Buffer.from(object.bytes)
    return (async function * (): FileObjectContent {
      signal?.throwIfAborted()
      yield bytes
      signal?.throwIfAborted()
    })()
  }

  async stat(ref: FileObjectRef, signal?: AbortSignal): Promise<FileObjectStat> {
    signal?.throwIfAborted()
    const object = this.resolve(ref, 'stat')
    return { status: 'ready', ref: structuredClone(object.ref) }
  }

  private resolve(ref: FileObjectRef, operation: 'open' | 'stat'): { ref: FileObjectRef; bytes: Buffer } {
    if (ref.storageBackend !== this.storageBackend) throw new FileStorageError('invalid-reference', operation)
    const object = this.objects.get(String(ref.sha256))
    if (object === undefined) throw new FileStorageError('not-found', operation)
    if (JSON.stringify(object.ref) !== JSON.stringify(ref)) throw new FileStorageError('invalid-reference', operation)
    return object
  }
}

runFileStorageContract('memory', async () => {
  const storage = new MemoryFileStorage(new Context())
  const digest = 'f'.repeat(64)
  return {
    storage,
    missingRef: {
      objectId: FileObjectId(`sha256:${digest}`),
      storageBackend: BACKEND,
      storageKey: FileStorageKey(`objects/ff/${digest}`),
      sha256: FileObjectSha256(digest),
      byteSize: 1,
    },
  }
})

describe('file storage public failures', () => {
  it.each([
    'invalid-reference', 'checksum-mismatch', 'size-mismatch', 'not-found', 'corrupt',
    'unavailable', 'read-failed', 'write-failed', 'metadata-failed',
  ] as const)('constructs the stable %s category without provider diagnostics', (code) => {
    const cause = new Error('private provider details')
    const error = new FileStorageError(code, 'open', { cause })
    expect(error).toMatchObject({ name: 'FileStorageError', code, operation: 'open', cause })
    expect(error.message).toBe(`File storage open failed: ${code}`)
  })
})

describe('file storage invariant companion', () => {
  it('registers and releases package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(InvariantCompanion)
    await fiber.dispose()
    await ctx.plugin(InvariantCompanion)
  })
})
