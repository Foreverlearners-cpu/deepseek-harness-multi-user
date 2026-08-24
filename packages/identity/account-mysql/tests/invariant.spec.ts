import { describe, expect, it, vi } from 'vitest'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { apply, inject, name } from '../src/invariant.ts'

describe('account-mysql invariant companion', () => {
  it('reserves package ownership without a runtime-only assertion', async () => {
    const disposer = vi.fn()
    let installed: InvariantInstaller = () => { throw new Error('installer was not registered') }
    const register = vi.fn((_packageName: string, installer: InvariantInstaller) => {
      installed = installer
      return disposer
    })
    await expect(apply({ invariants: { register } } as never)).resolves.toBe(disposer)
    expect(name).toBe('account-mysql-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-account-mysql', expect.any(Function))
    expect(installed({} as never, vi.fn() as never)).toBeUndefined()
  })
})
