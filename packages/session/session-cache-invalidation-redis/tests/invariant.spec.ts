import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, inject, name } from '../src/invariant.ts'

describe('session cache invalidation invariant companion', () => {
  it('registers package ownership and returns its disposer', async () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const result = await apply({ invariants: { register } } as unknown as Context)
    expect(name).toBe('session-cache-invalidation-redis-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-session-cache-invalidation-redis',
      expect.any(Function),
    )
    const installer = register.mock.calls[0]?.[1]
    expect(installer?.({} as Context, vi.fn())).toBeUndefined()
    expect(result).toBe(dispose)
  })
})
