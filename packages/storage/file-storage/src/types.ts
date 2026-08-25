/** Public file-object storage types. @module @deepseek-ai/dsh-file-storage/types */

import type {
  FileObjectId,
  FileObjectSha256,
  FileStorageBackend,
  FileStorageKey,
} from './brand.ts'

export type {
  FileObjectId,
  FileObjectSha256,
  FileStorageBackend,
  FileStorageKey,
} from './brand.ts'

/** Immutable, serializable reference returned after an object becomes ready. */
export interface FileObjectRef {
  /** Provider-issued opaque identity. */
  objectId: FileObjectId
  /** Provider responsible for resolving the storage key. */
  storageBackend: FileStorageBackend
  /** Provider-local opaque key; never a filesystem path or bearer URL. */
  storageKey: FileStorageKey
  /** SHA-256 digest of the complete object bytes. */
  sha256: FileObjectSha256
  /** Exact byte length of the complete object. */
  byteSize: number
}

/** Streaming input and optional integrity assertions for one immutable object. */
export interface PutFileObjectRequest {
  /** Ordered byte chunks; providers must not retain caller-owned chunk buffers. */
  content: AsyncIterable<Uint8Array>
  /** Optional expected digest checked before the object becomes ready. */
  expectedSha256?: FileObjectSha256
  /** Optional expected byte length checked before the object becomes ready. */
  expectedByteSize?: number
}

/** Metadata returned only for an object that is ready for complete reads. */
export interface FileObjectStat {
  status: 'ready'
  ref: FileObjectRef
}

/** Async byte stream returned by a provider after it resolves a ready object. */
export type FileObjectContent = AsyncIterable<Uint8Array>

/** Operation whose stable failure category is reported by {@link FileStorageError}. */
export type FileStorageOperation = 'put' | 'open' | 'stat'
