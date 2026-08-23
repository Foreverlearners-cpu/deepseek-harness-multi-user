/**
 * File-object storage service for DSH plugins.
 *
 * The default implementation stores immutable objects by SHA-256 under a
 * configured local root. Consumers depend on the service contract, not on
 * filesystem paths, so an S3/MinIO provider can replace this implementation
 * without changing conversation or message tables.
 * @module @deepseek-ai/dsh-file-storage
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FileObjectRef, FileObjectStore } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fileStorage: FileStorageService
  }
}

export type { FileObjectRef, FileObjectStore } from './types.ts'

/** Service configuration. The root is deliberately explicit. */
export interface Config {
  /** Durable root for local content-addressed objects. */
  root: string
}

/** Configuration schema used by the Cordis loader. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})

const SHA256_RE = /^[a-f0-9]{64}$/

/** Local content-addressed implementation of {@link FileObjectStore}. */
export class FileStorageService extends Service implements FileObjectStore {
  static Config: z<Config> = Config

  override readonly name: string = 'fileStorage'
  readonly storageBackend: string = 'local'
  /** Absolute root containing content-addressed object files. */
  readonly root: string

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'fileStorage')
    this.root = resolve(config.root)
  }

  /**
   * Publish bytes idempotently under `objects/<prefix>/<sha256>`.
   * @param data Bytes to publish.
   * @param expectedSha256 Optional digest supplied by the caller for validation.
   * @returns The immutable object reference published by this provider.
   */
  async put(data: Uint8Array, expectedSha256?: string): Promise<FileObjectRef> {
    const bytes = Buffer.from(data)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== sha256) {
      throw new Error('file checksum does not match expected sha256')
    }
    const storageKey = join('objects', sha256.slice(0, 2), sha256)
    const target = join(this.root, storageKey)
    await mkdir(dirname(target), { recursive: true })
    try {
      await stat(target)
    } catch {
      const temporary = join(dirname(target), `.${sha256}.${randomUUID()}.tmp`)
      await writeFile(temporary, bytes, { flag: 'wx' })
      try {
        await rename(temporary, target)
      } catch (error: unknown) {
        // Another request may have published the same digest concurrently.
        try { await stat(target) } catch { throw error }
      }
    }
    return {
      sha256,
      storageKey: storageKey.replaceAll('\\', '/'),
      storageBackend: this.storageBackend,
      byteSize: bytes.byteLength,
    }
  }

  /**
   * Read and verify an object by provider-local key and expected digest.
   * @param storageKey Provider-local object key returned by {@link put}.
   * @param expectedSha256 Digest that the returned bytes must match.
   * @param signal Optional cancellation signal.
   * @returns The verified object bytes.
   */
  async get(storageKey: string, expectedSha256: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted()
    const digest = expectedSha256.toLowerCase()
    if (!SHA256_RE.test(digest)) throw new Error('expected sha256 must be a 64-character hexadecimal digest')
    const target = resolve(this.root, storageKey)
    const prefix = `${this.root}${sep}`
    if (target === this.root || !target.startsWith(prefix)) throw new Error('invalid file storage key')
    const bytes = await readFile(target)
    signal?.throwIfAborted()
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) throw new Error('stored file checksum mismatch')
    return bytes
  }
}

export default FileStorageService
