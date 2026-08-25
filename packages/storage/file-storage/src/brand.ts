/** File-object storage identifiers. @module @deepseek-ai/dsh-file-storage/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Provider-issued identity for one immutable file object. */
export type FileObjectId = Branded<'FileObjectId'>
/** Provider name persisted beside an object reference. */
export type FileStorageBackend = Branded<'FileStorageBackend'>
/** Provider-local opaque key; consumers never parse it as a path or URL. */
export type FileStorageKey = Branded<'FileStorageKey'>
/** Lowercase hexadecimal SHA-256 digest of an object's complete bytes. */
export type FileObjectSha256 = Branded<'FileObjectSha256'>

/**
 * Brand a provider-issued object identity.
 * @param value - validated opaque identity.
 * @returns the branded identity.
 */
export function FileObjectId(value: string): FileObjectId {
  return value as FileObjectId
}

/**
 * Brand a configured provider name.
 * @param value - validated provider name.
 * @returns the branded provider name.
 */
export function FileStorageBackend(value: string): FileStorageBackend {
  return value as FileStorageBackend
}

/**
 * Brand a provider-issued storage key.
 * @param value - validated opaque key.
 * @returns the branded key.
 */
export function FileStorageKey(value: string): FileStorageKey {
  return value as FileStorageKey
}

/**
 * Brand a validated lowercase hexadecimal SHA-256 digest.
 * @param value - validated digest.
 * @returns the branded digest.
 */
export function FileObjectSha256(value: string): FileObjectSha256 {
  return value as FileObjectSha256
}
