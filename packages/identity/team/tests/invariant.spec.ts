import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { describe, expect, it } from 'vitest'
import { teamId, teamMembershipId, type TeamChangeEvent, type TeamMembershipChangeEvent } from '../src/index.ts'
import * as TeamInvariant from '../src/invariant.ts'
import { MemoryTeamDirectory } from './memory.ts'

const teamEvent: TeamChangeEvent = {
  kind: 'created',
  teamId: teamId('team-1'),
  tenantId: tenantId('tenant-1'),
  revision: 1,
  status: 'active',
  time: 1,
}

const membershipEvent: TeamMembershipChangeEvent = {
  kind: 'created',
  membershipId: teamMembershipId('membership-1'),
  teamId: teamId('team-1'),
  tenantId: tenantId('tenant-1'),
  userId: userId('user-1'),
  revision: 1,
  status: 'active',
  time: 1,
}

describe('team invariant companion', () => {
  it('accepts team events while the teams service is live', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(MemoryTeamDirectory)
    await ctx.plugin(TeamInvariant)

    expect(() => { ctx.emit('team/changed', teamEvent) }).not.toThrow()
    expect(() => { ctx.emit('team/membership-changed', membershipEvent) }).not.toThrow()
  })

  it('rejects team events without a live teams service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(TeamInvariant)

    expect(() => { ctx.emit('team/changed', teamEvent) }).toThrow(/without a live teams service/)
    expect(() => { ctx.emit('team/membership-changed', membershipEvent) }).toThrow(/without a live teams service/)
  })
})
