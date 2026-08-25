/** Crash-durable local provider for immutable file-object storage. @module @deepseek-ai/dsh-file-storage-local */

import { createHash, randomUUID } from 'node:crypto'
import { open as openFile, link, mkdir, rm, stat as statPath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import FileStorage, {
  FileObjectId,
  FileObjectSha256,
  FileStorageBackend,
  FileStorageError,
  FileStorageKey,
  type FileObjectContent,
  type FileObjectRef,
  type FileObjectStat,
  type FileStorageOperation,
  type PutFileObjectRequest,
} from '@deepseek-ai/dsh-file-storage'

const DIGEST_RE = /^[0-9a-f]{64}$/
const READ_BUFFER_BYTES = 64 * 1024

/** Backend identity persisted in references issued by this provider. */
export const LOCAL_FILE_STORAGE_BACKEND = FileStorageBackend('local')

/** Local provider configuration. */
export interface Config {
  /** Private root containing staging files and content-addressed objects. */
  root: string
}

/** Local provider configuration schema. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

/** Content-addressed local filesystem implementation of {@link FileStorage}. */
export class LocalFileStorage extends FileStorage {
  static Config = Config
  readonly storageBackend = LOCAL_FILE_STORAGE_BACKEND
  private readonly root: string
  private readonly stagingRoot: string

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(config.root)
    this.stagingRoot = join(this.root, '.staging')
  }

  /**
   * Stream bytes into same-root staging and atomically publish by hard link.
   * @param request - byte stream and optional complete-object assertions.
   * @param signal - optional cancellation preserved as its original reason.
   * @returns a durable content-addressed reference.
   */
  async put(request: PutFileObjectRequest, signal?: AbortSignal): Promise<FileObjectRef> {
    signal?.throwIfAborted()
    let stagingPath: string | undefined
    let handle: FileHandle | undefined
    try {
      await ensureDurableTree(this.root)
      await ensureDurableSubdirectory(this.stagingRoot, this.root)
      stagingPath = join(this.stagingRoot, `${randomUUID()}.tmp`)
      handle = await openFile(stagingPath, 'wx', 0o600)
      const { digest, byteSize } = await writeStream(handle, request.content, signal)
      await handle.sync()
      await handle.close()
      handle = undefined
      signal?.throwIfAborted()

      if (request.expectedSha256 !== undefined && request.expectedSha256 !== digest) {
        throw new FileStorageError('checksum-mismatch', 'put')
      }
      if (request.expectedByteSize !== undefined && request.expectedByteSize !== byteSize) {
        throw new FileStorageError('size-mismatch', 'put')
      }

      const ref = makeRef(digest, byteSize)
      const target = this.pathFor(ref)
      await ensureDurableSubdirectory(dirname(target), this.root)
      try {
        await link(stagingPath, target)
        await fsyncDirectoryChain(dirname(target), this.root)
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
        await verifyFile(target, ref, 'put', signal)
        await fsyncDirectoryChain(dirname(target), this.root)
      }
      return ref
    } catch (error) {
      if (error instanceof FileStorageError || isAbortReason(error, signal)) throw error
      throw new FileStorageError('write-failed', 'put', { cause: error })
    } finally {
      await handle?.close().catch(() => undefined)
      if (stagingPath !== undefined) await rm(stagingPath, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Open a validated reference and verify digest and size during iteration.
   * @param ref - provider-issued immutable-object reference.
   * @param signal - optional cancellation for open and iteration.
   * @returns an owned stream that closes its file handle on completion or early return.
   */
  async open(ref: FileObjectRef, signal?: AbortSignal): Promise<FileObjectContent> {
    signal?.throwIfAborted()
    this.validateRef(ref, 'open')
    let handle: FileHandle | undefined
    try {
      handle = await openFile(this.pathFor(ref), 'r')
      await verifyMetadata(handle, ref, 'open')
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (isAbortReason(error, signal) || error instanceof FileStorageError) throw error
      if (hasCode(error, 'ENOENT')) throw new FileStorageError('not-found', 'open', { cause: error })
      throw new FileStorageError('read-failed', 'open', { cause: error })
    }
    return readVerified(handle, ref, signal)
  }

  /**
   * Verify a reference and its filesystem metadata without reading content.
   * @param ref - provider-issued immutable-object reference.
   * @param signal - optional cancellation.
   * @returns canonical ready metadata.
   */
  async stat(ref: FileObjectRef, signal?: AbortSignal): Promise<FileObjectStat> {
    signal?.throwIfAborted()
    this.validateRef(ref, 'stat')
    let handle: FileHandle | undefined
    try {
      handle = await openFile(this.pathFor(ref), 'r')
      await verifyMetadata(handle, ref, 'stat')
      signal?.throwIfAborted()
      return { status: 'ready', ref: makeRef(String(ref.sha256), ref.byteSize) }
    } catch (error) {
      if (isAbortReason(error, signal) || error instanceof FileStorageError) throw error
      if (hasCode(error, 'ENOENT')) throw new FileStorageError('not-found', 'stat', { cause: error })
      throw new FileStorageError('metadata-failed', 'stat', { cause: error })
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private validateRef(ref: FileObjectRef, operation: 'open' | 'stat'): void {
    const digest = String(ref.sha256)
    if (
      ref.storageBackend !== this.storageBackend
      || !DIGEST_RE.test(digest)
      || !Number.isSafeInteger(ref.byteSize)
      || ref.byteSize < 0
      || String(ref.objectId) !== `sha256:${digest}`
      || String(ref.storageKey) !== storageKey(digest)
    ) {
      throw new FileStorageError('invalid-reference', operation)
    }
  }

  private pathFor(ref: FileObjectRef): string {
    return join(this.root, ...String(ref.storageKey).split('/'))
  }
}

async function writeStream(
  handle: FileHandle,
  content: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<{ digest: string; byteSize: number }> {
  const hash = createHash('sha256')
  let byteSize = 0
  const iterator = content[Symbol.asyncIterator]()
  let complete = false
  try {
    while (true) {
      const result = await nextWithAbort(iterator, signal)
      if (result.done) break
      signal?.throwIfAborted()
      const bytes = Uint8Array.from(result.value)
      await handle.writeFile(bytes)
      hash.update(bytes)
      byteSize += bytes.byteLength
      if (!Number.isSafeInteger(byteSize)) throw new RangeError('file object exceeds safe byte length')
    }
    signal?.throwIfAborted()
    complete = true
    return { digest: hash.digest('hex'), byteSize }
  } finally {
    if (complete || signal?.aborted !== true) {
      await iterator.return?.()
    } else {
      try {
        const returned = iterator.return?.()
        if (returned !== undefined) void returned.catch(() => undefined)
      } catch {
        // Source cleanup cannot replace the caller's cancellation reason.
      }
    }
  }
}

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  signal?.throwIfAborted()
  if (signal === undefined) return iterator.next()
  return new Promise((resolveNext, rejectNext) => {
    const abort = () => {
      rejectNext(signal.reason as Error)
    }
    signal.addEventListener('abort', abort, { once: true })
    void iterator.next().then(resolveNext, rejectNext).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

function readVerified(handle: FileHandle, ref: FileObjectRef, signal?: AbortSignal): FileObjectContent {
  return (async function * (): FileObjectContent {
    const hash = createHash('sha256')
    let byteSize = 0
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES)
    try {
      while (true) {
        signal?.throwIfAborted()
        let bytesRead: number
        try {
          ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null))
        } catch (error) {
          if (isAbortReason(error, signal)) throw error
          throw new FileStorageError('read-failed', 'open', { cause: error })
        }
        if (bytesRead === 0) break
        const chunk = Uint8Array.from(buffer.subarray(0, bytesRead))
        hash.update(chunk)
        byteSize += bytesRead
        yield chunk
      }
      signal?.throwIfAborted()
      if (byteSize !== ref.byteSize || hash.digest('hex') !== ref.sha256) {
        throw new FileStorageError('corrupt', 'open')
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  })()
}

async function verifyFile(
  path: string,
  ref: FileObjectRef,
  operation: FileStorageOperation,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await openFile(path, 'r')
  try {
    await verifyMetadata(handle, ref, operation)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES)
    let byteSize = 0
    while (true) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      byteSize += bytesRead
    }
    if (byteSize !== ref.byteSize || hash.digest('hex') !== ref.sha256) {
      throw new FileStorageError('corrupt', operation)
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function verifyMetadata(
  handle: FileHandle,
  ref: FileObjectRef,
  operation: FileStorageOperation,
): Promise<void> {
  const metadata = await handle.stat()
  if (!metadata.isFile() || metadata.size !== ref.byteSize) {
    throw new FileStorageError('corrupt', operation)
  }
}

function makeRef(digest: string, byteSize: number): FileObjectRef {
  return {
    objectId: FileObjectId(`sha256:${digest}`),
    storageBackend: LOCAL_FILE_STORAGE_BACKEND,
    storageKey: FileStorageKey(storageKey(digest)),
    sha256: FileObjectSha256(digest),
    byteSize,
  }
}

function storageKey(digest: string): string {
  return `objects/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function isAbortReason(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true && error === signal.reason
}

/* v8 ignore start -- Windows rejects directory handles; POSIX coverage exercises crash durability. */
async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await openFile(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */

async function fsyncDirectoryChain(path: string, boundary: string): Promise<void> {
  let current = path
  while (true) {
    await fsyncDirectory(current)
    if (current === boundary) return
    const parent = dirname(current)
    /* v8 ignore next -- callers derive both paths from one resolved storage root. */
    if (parent === current) throw new Error('durability boundary is not an ancestor')
    current = parent
  }
}

async function ensureDurableTree(path: string): Promise<void> {
  let existing = path
  while (true) {
    try {
      const metadata = await statPath(existing)
      if (!metadata.isDirectory()) throw new Error('file storage root ancestor is not a directory')
      break
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      const parent = dirname(existing)
      /* v8 ignore next -- an absent filesystem root is an environment failure with no writable ancestor. */
      if (parent === existing) throw error
      existing = parent
    }
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  await fsyncDirectoryChain(path, existing)
}

async function ensureDurableSubdirectory(path: string, boundary: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await fsyncDirectoryChain(path, boundary)
}

export default LocalFileStorage
