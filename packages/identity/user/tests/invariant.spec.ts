import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import { userId, type UserChangeEvent } from '../src/index.ts'
import * as UserInvariant from '../src/invariant.ts'
import { MemoryUserDirectory } from './memory.ts'

const event: UserChangeEvent = {
  kind: 'created',
  userId: userId('user-1'),
  revision: 1,
  status: 'active',
  time: 1,
}

describe('user invariant companion', () => {
  it('accepts user events while the users service is live', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(MemoryUserDirectory)
    await ctx.plugin(UserInvariant)

    expect(() => { ctx.emit('user/changed', event) }).not.toThrow()
  })

  it('rejects user events without a live users service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(UserInvariant)

    expect(() => { ctx.emit('user/changed', event) }).toThrow(/without a live users service/)
  })
})
