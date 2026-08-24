import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { apply, inject, name } from '../src/invariant.ts'

describe('session cache invalidation invariant companion', () => {
  it('registers package ownership and returns its disposer', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, _installer: InvariantInstaller) => dispose)
    const result = await apply({ invariants: { register } } as unknown as Context)
    expect(name).toBe('session-cache-invalidation-redis-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-session-cache-invalidation-redis',
      expect.any(Function),
    )
    const installer = register.mock.calls[0]?.[1]
    const fail: InvariantFailure = (message) => { throw new Error(message) }
    expect(installer?.({} as Context, fail)).toBeUndefined()
    expect(result).toBe(dispose)
  })
})
