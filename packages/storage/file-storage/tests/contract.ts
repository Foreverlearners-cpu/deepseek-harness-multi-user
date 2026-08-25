/** Shared conformance suite for file-object storage providers. @module */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FileObjectSha256,
  type FileObjectRef,
  type FileStorage,
} from '../src/index.ts'

/** Fresh provider and provider-valid reference that does not exist. */
export interface FileStorageContractHarness {
  storage: FileStorage
  missingRef: FileObjectRef
  close?(): Promise<void>
}

async function * chunks(...values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Uint8Array[] = []
  for await (const value of content) values.push(value)
  return Buffer.concat(values)
}

/**
 * Run the provider-independent immutable-object contract.
 * @param label - provider label shown by the test runner.
 * @param create - factory returning a fresh empty provider.
 */
export function runFileStorageContract(
  label: string,
  create: () => Promise<FileStorageContractHarness>,
): void {
  describe(`file storage provider contract: ${label}`, () => {
    it('publishes a multi-chunk object as ready and streams the complete bytes', async () => {
      const harness = await create()
      const first = Uint8Array.of(1, 2)
      const second = Uint8Array.of(3, 4, 5)
      const expected = Buffer.from([1, 2, 3, 4, 5])
      const ref = await harness.storage.put({ content: chunks(first, new Uint8Array(), second) })
      first.fill(9)
      second.fill(9)

      expect(ref).toMatchObject({
        storageBackend: harness.storage.storageBackend,
        sha256: createHash('sha256').update(expected).digest('hex'),
        byteSize: 5,
      })
      await expect(harness.storage.stat(ref)).resolves.toEqual({ status: 'ready', ref })
      await expect(harness.storage.open(ref).then(collect)).resolves.toEqual(expected)
      await harness.close?.()
    })

    it('accepts an empty object and matching complete-object assertions', async () => {
      const harness = await create()
      const digest = FileObjectSha256(createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
      const ref = await harness.storage.put({
        content: chunks(),
        expectedSha256: digest,
        expectedByteSize: 0,
      })

      expect(ref).toMatchObject({ sha256: digest, byteSize: 0 })
      await expect(harness.storage.open(ref).then(collect)).resolves.toEqual(Buffer.alloc(0))
      await harness.close?.()
    })

    it('deduplicates identical immutable bytes without changing their reference', async () => {
      const harness = await create()
      const first = await harness.storage.put({ content: chunks(Buffer.from('same')) })
      const second = await harness.storage.put({
        content: chunks(Buffer.from('same')),
        expectedSha256: first.sha256,
        expectedByteSize: first.byteSize,
      })

      expect(second).toEqual(first)
      await harness.close?.()
    })

    it('rejects digest and byte-length mismatches without returning a reference', async () => {
      const harness = await create()
      await expect(harness.storage.put({
        content: chunks(Buffer.from('actual')),
        expectedSha256: FileObjectSha256('0'.repeat(64)),
      })).rejects.toMatchObject({ name: 'FileStorageError', code: 'checksum-mismatch', operation: 'put' })
      await expect(harness.storage.put({
        content: chunks(Buffer.from('actual')),
        expectedByteSize: 99,
      })).rejects.toMatchObject({ name: 'FileStorageError', code: 'size-mismatch', operation: 'put' })
      await harness.close?.()
    })

    it('classifies missing objects and references for another backend', async () => {
      const harness = await create()
      await expect(harness.storage.stat(harness.missingRef))
        .rejects.toMatchObject({ code: 'not-found', operation: 'stat' })
      await expect(harness.storage.open(harness.missingRef))
        .rejects.toMatchObject({ code: 'not-found', operation: 'open' })
      const foreign = { ...harness.missingRef, storageBackend: `${harness.storage.storageBackend}-foreign` }
      await expect(harness.storage.stat(foreign as FileObjectRef))
        .rejects.toMatchObject({ code: 'invalid-reference', operation: 'stat' })
      await expect(harness.storage.open(foreign as FileObjectRef))
        .rejects.toMatchObject({ code: 'invalid-reference', operation: 'open' })
      await harness.close?.()
    })

    it('preserves cancellation before publication, resolution, and stream iteration', async () => {
      const harness = await create()
      const putAbort = new AbortController()
      putAbort.abort(new Error('stop put'))
      await expect(harness.storage.put({ content: chunks(Buffer.from('x')) }, putAbort.signal))
        .rejects.toThrow('stop put')

      const ref = await harness.storage.put({ content: chunks(Buffer.from('ready')) })
      const statAbort = new AbortController()
      statAbort.abort(new Error('stop stat'))
      await expect(harness.storage.stat(ref, statAbort.signal)).rejects.toThrow('stop stat')
      const readAbort = new AbortController()
      const opened = await harness.storage.open(ref, readAbort.signal)
      readAbort.abort(new Error('stop read'))
      await expect(collect(opened)).rejects.toThrow('stop read')
      await harness.close?.()
    })
  })
}
