import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { userId } from '@deepseek-ai/dsh-user'
import { describe, expect, it } from 'vitest'
import { membershipId, tenantId, type TenantChangeEvent, type TenantMembershipChangeEvent } from '../src/index.ts'
import * as TenantInvariant from '../src/invariant.ts'
import { MemoryTenantDirectory } from './memory.ts'

const tenantEvent: TenantChangeEvent = {
  kind: 'created',
  tenantId: tenantId('tenant-1'),
  revision: 1,
  status: 'active',
  time: 1,
}

const membershipEvent: TenantMembershipChangeEvent = {
  kind: 'created',
  membershipId: membershipId('membership-1'),
  tenantId: tenantId('tenant-1'),
  userId: userId('user-1'),
  revision: 1,
  status: 'active',
  time: 1,
}

describe('tenant invariant companion', () => {
  it('accepts tenant events while the tenants service is live', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(MemoryTenantDirectory)
    await ctx.plugin(TenantInvariant)

    expect(() => { ctx.emit('tenant/changed', tenantEvent) }).not.toThrow()
    expect(() => { ctx.emit('tenant/membership-changed', membershipEvent) }).not.toThrow()
  })

  it('rejects tenant events without a live tenants service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(TenantInvariant)

    expect(() => { ctx.emit('tenant/changed', tenantEvent) }).toThrow(/without a live tenants service/)
    expect(() => { ctx.emit('tenant/membership-changed', membershipEvent) }).toThrow(/without a live tenants service/)
  })
})
