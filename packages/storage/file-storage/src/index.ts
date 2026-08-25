/** Provider-neutral immutable file-object storage service (`ctx.fileStorage`). @module @deepseek-ai/dsh-file-storage */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  FileObjectContent,
  FileObjectRef,
  FileObjectStat,
  FileStorageBackend,
  PutFileObjectRequest,
} from './types.ts'

export {
  FileObjectId,
  FileObjectSha256,
  FileStorageBackend,
  FileStorageKey,
} from './brand.ts'
export { FileStorageError } from './error.ts'
export type { FileStorageErrorCode } from './error.ts'
export type {
  FileObjectContent,
  FileObjectId as FileObjectIdType,
  FileObjectRef,
  FileObjectSha256 as FileObjectSha256Type,
  FileObjectStat,
  FileStorageBackend as FileStorageBackendType,
  FileStorageKey as FileStorageKeyType,
  FileStorageOperation,
  PutFileObjectRequest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fileStorage: FileStorage
  }
}

/**
 * Immutable object storage service implemented by local or remote providers.
 *
 * Providers own physical publication and verify complete-object digest and byte
 * length before returning from {@link put}. A returned reference is ready:
 * {@link stat} and {@link open} can resolve it immediately, including after a
 * provider restart. Consumers persist every reference field verbatim and never
 * parse the provider name, key, or object id.
 */
export abstract class FileStorage extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fileStorage')
  }

  /** Stable name written into every reference produced by this provider. */
  abstract readonly storageBackend: FileStorageBackend

  /**
   * Consume an ordered byte stream and publish one immutable object.
   *
   * Resolution means the complete object is durable according to the provider,
   * its digest and length match optional expectations, and it is ready for
   * {@link open}. Empty objects are valid. A rejected operation publishes no
   * reference, although unreachable immutable bytes may await garbage collection.
   *
   * @param request - content stream and optional complete-object assertions.
   * @param signal - optional cancellation observed while consuming and publishing.
   * @returns a durable ready reference.
   */
  abstract put(request: PutFileObjectRequest, signal?: AbortSignal): Promise<FileObjectRef>

  /**
   * Resolve one ready object and return its ordered byte stream.
   *
   * The provider checks that the reference names this backend and that streamed
   * bytes match its recorded digest and length. Cancellation can reject this
   * method or subsequent stream iteration with the signal reason.
   *
   * @param ref - complete provider-issued reference persisted by a consumer.
   * @param signal - optional cancellation for resolution and stream iteration.
   * @returns an async stream whose concatenation is the complete immutable object.
   */
  abstract open(ref: FileObjectRef, signal?: AbortSignal): Promise<FileObjectContent>

  /**
   * Resolve and verify metadata for one ready object without reading its content.
   *
   * @param ref - complete provider-issued reference persisted by a consumer.
   * @param signal - optional cancellation for metadata resolution.
   * @returns canonical ready metadata equal to the persisted reference.
   */
  abstract stat(ref: FileObjectRef, signal?: AbortSignal): Promise<FileObjectStat>
}

export default FileStorage
