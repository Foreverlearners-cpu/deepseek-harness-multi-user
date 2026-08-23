/** Public contract for a DSH file-object storage service. */

export interface FileObjectRef {
  /** Content digest in lowercase hexadecimal SHA-256 form. */
  sha256: string
  /** Provider-local key used to read the object back. */
  storageKey: string
  /** Provider name persisted with the reference. */
  storageBackend: string
  /** Number of bytes published. */
  byteSize: number
}

/**
 * The capability consumed by domain plugins that need file bytes.
 * Implementations may be local, S3-compatible, or another object store.
 */
export interface FileObjectStore {
  readonly storageBackend: string

  put(data: Uint8Array, expectedSha256?: string): Promise<FileObjectRef>

  get(storageKey: string, expectedSha256: string, signal?: AbortSignal): Promise<Buffer>
}
