import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/invariant.ts'

describe('tenant-mysql invariant companion', () => {
  it('registers package ownership', async () => {
    const register = vi.fn(() => vi.fn())
    const ctx = new Context()
    ctx.provide('invariants', { register } as never)

    await expect(apply(ctx)).resolves.toEqual(expect.any(Function))
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-tenant-mysql', expect.any(Function))
  })
})
