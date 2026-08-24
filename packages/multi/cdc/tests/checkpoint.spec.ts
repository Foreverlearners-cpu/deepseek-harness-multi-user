import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readCheckpoint, writeCheckpoint } from '../src/checkpoint.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cdc-test-'))
  directories.push(directory)
  const nested = join(directory, 'nested')
  await mkdir(nested)
  return join(nested, 'checkpoint.json')
}

describe('CDC checkpoint', () => {
  it('returns undefined for first start and atomically round-trips a checkpoint', async () => {
    const path = await temporaryPath()
    await expect(readCheckpoint(path)).resolves.toBeUndefined()
    const checkpoint = {
      version: 1 as const,
      file: 'mysql-bin.000042',
      position: 18291,
      schemas: { 'app.users': 'fingerprint' },
    }
    await writeCheckpoint(path, checkpoint)
    await expect(readCheckpoint(path)).resolves.toEqual(checkpoint)
    expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify(checkpoint)}\n`)
    const advanced = { ...checkpoint, position: 20_000 }
    await writeCheckpoint(path, advanced)
    await expect(readCheckpoint(path)).resolves.toEqual(advanced)
  })

  it('fails loudly for corrupt and structurally invalid checkpoints', async () => {
    const path = await temporaryPath()
    await writeFile(path, '{')
    await expect(readCheckpoint(path)).rejects.toThrow(/invalid JSON/u)
    await writeFile(path, JSON.stringify({ version: 1, file: '', position: 'bad', schemas: {} }))
    await expect(readCheckpoint(path)).rejects.toThrow(/checkpoint file is invalid/u)
    await writeFile(path, JSON.stringify({
      version: 1,
      file: 'mysql-bin.000001',
      position: 3,
      schemas: {},
    }))
    await expect(readCheckpoint(path)).rejects.toThrow(/checkpoint file is invalid/u)
  })
})
