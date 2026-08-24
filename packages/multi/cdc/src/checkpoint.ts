import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { CdcCheckpoint } from './types.ts'

async function syncPublishedPath(path: string): Promise<void> {
  const published = await open(path, 'r+')
  try {
    await published.sync()
  } finally {
    await published.close()
  }

  if (process.platform === 'win32') return
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function validate(value: unknown): CdcCheckpoint {
  const schemas = (value as { schemas?: unknown } | null)?.schemas
  if (
    typeof value !== 'object' || value === null
    || (value as { version?: unknown }).version !== 1
    || typeof (value as { file?: unknown }).file !== 'string'
    || (value as { file: string }).file.length === 0
    || !Number.isSafeInteger((value as { position?: unknown }).position)
    || Number((value as { position?: unknown }).position) < 4
    || typeof schemas !== 'object' || schemas === null || Array.isArray(schemas)
    || Object.values(schemas).some(fingerprint => typeof fingerprint !== 'string' || fingerprint.length === 0)
  ) throw new Error('cdc: checkpoint file is invalid')
  return value as CdcCheckpoint
}

/**
 * Read a checkpoint, returning undefined only when the file has never existed.
 * @param path - Explicit checkpoint file path.
 * @returns The validated checkpoint, or undefined for a first start.
 */
export async function readCheckpoint(path: string): Promise<CdcCheckpoint | undefined> {
  try {
    return validate(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (cause instanceof SyntaxError) throw new Error('cdc: checkpoint file is invalid JSON', { cause })
    throw cause
  }
}

/**
 * Atomically replace a checkpoint and flush its contents before publication.
 * @param path - Explicit checkpoint file path.
 * @param checkpoint - Fully acknowledged restart position to publish.
 * @returns A promise that settles after the replacement is visible.
 */
export async function writeCheckpoint(path: string, checkpoint: CdcCheckpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    await syncPublishedPath(path)
  } catch (cause) {
    await rm(temporary, { force: true })
    throw cause
  }
}
