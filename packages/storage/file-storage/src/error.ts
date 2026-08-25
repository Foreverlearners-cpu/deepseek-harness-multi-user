/** Stable file-object storage failures. @module @deepseek-ai/dsh-file-storage/error */

import type { FileStorageOperation } from './types.ts'

/** Provider-independent failure categories for durable-object operations. */
export type FileStorageErrorCode =
  | 'invalid-reference'
  | 'checksum-mismatch'
  | 'size-mismatch'
  | 'not-found'
  | 'corrupt'
  | 'unavailable'
  | 'read-failed'
  | 'write-failed'
  | 'metadata-failed'

/** Classified failure without object keys, host paths, URLs, or object content in its message. */
export class FileStorageError extends Error {
  override readonly name = 'FileStorageError'

  /**
   * @param code - stable failure category for caller and operator handling.
   * @param operation - object operation that failed.
   * @param options - optional provider failure retained as a non-serialized cause.
   */
  constructor(
    readonly code: FileStorageErrorCode,
    readonly operation: FileStorageOperation,
    options?: ErrorOptions,
  ) {
    super(`File storage ${operation} failed: ${code}`, options)
  }
}
