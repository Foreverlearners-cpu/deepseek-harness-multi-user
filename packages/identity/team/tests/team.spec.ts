import { Context } from '@deepseek-ai/cordis'
import { tenantId, type TenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import { describe, expect, it, vi } from 'vitest'
import TeamDirectory, {
  MAX_MEMBERSHIP_LIST_LIMIT,
  MAX_TEAM_DISPLAY_NAME_LENGTH,
  TeamDirectoryError,
  teamId,
  teamMembershipId,
  type TeamCreateRecordInput,
  type TeamId,
  type TeamMembershipCreateRecordInput,
  type TeamMembershipListQuery,
  type TeamMembershipMutation,
  type TeamMembershipMutationCommit,
  type TeamMembershipPage,
  type TeamMembershipRecord,
  type TeamMutation,
  type TeamMutationCommit,
  type TeamRecord,
} from '../src/index.ts'
import { runTeamDirectoryContract } from './contract.ts'
import { MemoryTeamDirectory } from './memory.ts'

async function setup<T extends TeamDirectory>(Provider: new (ctx: Context) => T): Promise<{ ctx: Context; teams: T }> {
  const ctx = new Context()
  await ctx.plugin(Provider)
  return { ctx, teams: ctx.teams as T }
}

runTeamDirectoryContract('memory', () => setup(MemoryTeamDirectory))

class BrokenTeamDirectory extends TeamDirectory {
  createFailure: Error | undefined
  teamResult: unknown
  membershipResult: unknown
  teamMutationResult: unknown
  membershipMutationResult: unknown
  pageResult: unknown

  constructor(ctx: Context) {
    super(ctx)
    this.createFailure = new Error('database password must not escape')
    this.teamResult = undefined
    this.membershipResult = undefined
    this.teamMutationResult = undefined
    this.membershipMutationResult = undefined
    this.pageResult = { memberships: [] }
  }

  protected createTeamRecord(_input: TeamCreateRecordInput): Promise<TeamRecord> {
    return this.createFailure === undefined
      ? Promise.resolve(this.teamResult as TeamRecord)
      : Promise.reject(this.createFailure)
  }

  protected readTeamRecord(_id: TeamId): Promise<TeamRecord | undefined> {
    return Promise.resolve(this.teamResult as TeamRecord | undefined)
  }

  protected mutateTeamRecord(_mutation: TeamMutation): Promise<TeamMutationCommit> {
    return Promise.resolve(this.teamMutationResult as TeamMutationCommit)
  }

  protected createMembershipRecord(_input: TeamMembershipCreateRecordInput): Promise<TeamMembershipRecord> {
    return this.createFailure === undefined
      ? Promise.resolve(this.membershipResult as TeamMembershipRecord)
      : Promise.reject(this.createFailure)
  }

  protected readMembershipRecord(_id: TeamId, _member: UserId): Promise<TeamMembershipRecord | undefined> {
    return Promise.resolve(this.membershipResult as TeamMembershipRecord | undefined)
  }

  protected mutateMembershipRecord(_mutation: TeamMembershipMutation): Promise<TeamMembershipMutationCommit> {
    return Promise.resolve(this.membershipMutationResult as TeamMembershipMutationCommit)
  }

  protected listMembershipRecords(_query: TeamMembershipListQuery): Promise<TeamMembershipPage> {
    return Promise.resolve(this.pageResult as TeamMembershipPage)
  }
}

function teamRecord(overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    teamId: teamId('team-1'),
    tenantId: tenantId('tenant-1'),
    displayName: 'Platform',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

function teamRecordWithoutName(overrides: Partial<Omit<TeamRecord, 'displayName'>> = {}): TeamRecord {
  return {
    teamId: teamId('team-1'),
    tenantId: tenantId('tenant-1'),
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

function memberRecord(overrides: Partial<TeamMembershipRecord> = {}): TeamMembershipRecord {
  return {
    membershipId: teamMembershipId('membership-1'),
    teamId: teamId('team-1'),
    tenantId: tenantId('tenant-1'),
    userId: userId('user-1'),
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

describe('team directory validation', () => {
  it('rejects invalid ids, display names, revisions, contexts, and list queries', async () => {
    const { teams } = await setup(MemoryTeamDirectory)
    const owner = tenantId('tenant-1')
    expect(() => teamId('bad id')).toThrow(TypeError)
    expect(() => teamMembershipId('bad id')).toThrow(TypeError)
    await expect(teams.create({ tenantId: owner, displayName: '   ' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.create({ tenantId: owner, displayName: 1 as never })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.create({ tenantId: owner, displayName: 'x'.repeat(MAX_TEAM_DISPLAY_NAME_LENGTH + 1) }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.create({ tenantId: 'bad id' as TenantId })).rejects.toThrow(TypeError)
    const created = await teams.create({ tenantId: owner })
    await expect(teams.disable({ teamId: created.teamId, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.disable({
      teamId: created.teamId,
      expectedRevision: 1,
      context: { correlationId: '', reason: '' },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.disable({
      teamId: created.teamId,
      expectedRevision: 1,
      context: { correlationId: 'x'.repeat(129) },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.disable({
      teamId: created.teamId,
      expectedRevision: 1,
      context: { reason: '' },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.disable({
      teamId: created.teamId,
      expectedRevision: 1,
      context: { reason: 'x'.repeat(501) },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.disable({
      teamId: created.teamId,
      expectedRevision: 1,
      context: { actorUserId: 'bad id' as UserId },
    })).rejects.toThrow(TypeError)
    await expect(teams.listMembers({ teamId: created.teamId, limit: 0 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listMembers({ teamId: created.teamId, limit: 1.5 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listMembers({ teamId: created.teamId, limit: MAX_MEMBERSHIP_LIST_LIMIT + 1 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listMembers({ teamId: created.teamId, cursor: '' }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listMembers({ teamId: created.teamId, cursor: 1 as never }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listMembers({ teamId: created.teamId, cursor: 'x'.repeat(1025) }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listMembers({ teamId: created.teamId, status: 'unknown' as never }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listMembers({ teamId: teamId('missing') }))
      .rejects.toMatchObject({ code: 'team-not-found' })
    await expect(teams.listUserTeams({ userId: userId('user-1'), tenantId: owner, cursor: 'abc' }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.requireActiveMembership(created.teamId, userId('missing')))
      .rejects.toMatchObject({ code: 'membership-not-found' })
    await expect(teams.listMembers({ teamId: created.teamId, status: 'removed' }))
      .resolves.toMatchObject({ memberships: [] })
  })

  it('accepts empty and partial operation context', async () => {
    const { teams } = await setup(MemoryTeamDirectory)
    const owner = tenantId('tenant-1')
    const created = await teams.create({ tenantId: owner, context: {} })
    const disabled = await teams.disable({
      teamId: created.teamId,
      expectedRevision: created.revision,
      context: { correlationId: 'request-only' },
    })
    expect(disabled.status).toBe('disabled')
    const enabled = await teams.enable({
      teamId: created.teamId,
      expectedRevision: disabled.revision,
      context: { reason: '  restore  ' },
    })
    expect(enabled.status).toBe('active')
  })

  it('normalizes unexpected Provider failures and malformed Provider records', async () => {
    const { teams } = await setup(BrokenTeamDirectory)
    await expect(teams.create({ tenantId: tenantId('tenant-1') })).rejects.toEqual(expect.objectContaining({
      name: 'TeamDirectoryError',
      code: 'provider-unavailable',
      message: 'team: directory Provider failed',
    }))
    teams.createFailure = undefined
    teams.teamResult = {
      teamId: teamId('team-1'),
      tenantId: tenantId('tenant-1'),
      status: 'active',
      createdAt: 2,
      updatedAt: 1,
      revision: 1,
    }
    await expect(teams.create({ tenantId: tenantId('tenant-1') })).rejects.toMatchObject({ code: 'provider-unavailable' })
    await expect(teams.get(teamId('team-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    Object.create(null),
    teamRecord({ teamId: 'bad id' as TeamId }),
    teamRecord({ tenantId: 'bad id' as TenantId }),
    teamRecord({ status: 'unknown' as never }),
    teamRecord({ createdAt: -1 }),
    teamRecord({ updatedAt: -1 }),
    teamRecord({ revision: 0 }),
    teamRecord({ displayName: ' Before ' }),
  ])('rejects malformed Provider team record %#', async (badRecord) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.teamResult = badRecord
    await expect(teams.get(teamId('team-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    teamRecordWithoutName({ status: 'disabled' }),
    teamRecordWithoutName({ revision: 2 }),
    teamRecordWithoutName({ tenantId: tenantId('other') }),
    teamRecord({ displayName: 'Unexpected' }),
  ])('rejects invalid initial Provider team record %#', async (badRecord) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.createFailure = undefined
    teams.teamResult = badRecord
    await expect(teams.create({ tenantId: tenantId('tenant-1') })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    memberRecord({ membershipId: 'bad id' as never }),
    memberRecord({ teamId: 'bad id' as TeamId }),
    memberRecord({ tenantId: 'bad id' as TenantId }),
    memberRecord({ userId: 'bad id' as UserId }),
    memberRecord({ status: 'unknown' as never }),
    memberRecord({ createdAt: -1 }),
    memberRecord({ updatedAt: -1 }),
    memberRecord({ revision: 0 }),
    memberRecord({ createdAt: 2, updatedAt: 1 }),
  ])('rejects malformed Provider membership record %#', async (badRecord) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.membershipResult = badRecord
    await expect(teams.getMembership(teamId('team-1'), userId('user-1')))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    memberRecord({ status: 'disabled' }),
    memberRecord({ revision: 2 }),
    memberRecord({ teamId: teamId('other') }),
    memberRecord({ tenantId: tenantId('other') }),
    memberRecord({ userId: userId('other') }),
  ])('rejects invalid initial Provider membership record %#', async (badRecord) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.createFailure = undefined
    teams.teamResult = teamRecordWithoutName()
    teams.membershipResult = badRecord
    await expect(teams.addMember({
      teamId: teamId('team-1'),
      tenantId: tenantId('tenant-1'),
      userId: userId('user-1'),
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    undefined,
    { previous: teamRecord({ teamId: teamId('other') }), current: teamRecord({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: teamRecord(), current: teamRecord({ teamId: teamId('other'), status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: teamRecord({ revision: 2 }), current: teamRecord({ status: 'disabled', revision: 3, updatedAt: 2 }) },
    { previous: teamRecord(), current: teamRecord({ status: 'disabled', revision: 3, updatedAt: 2 }) },
    { previous: teamRecord(), current: teamRecord({ status: 'disabled', createdAt: 2, revision: 2, updatedAt: 2 }) },
    { previous: teamRecord({ updatedAt: 2 }), current: teamRecord({ status: 'disabled', revision: 2, updatedAt: 1 }) },
    { previous: teamRecord({ status: 'deleted' }), current: teamRecord({ status: 'deleted', revision: 2, updatedAt: 2 }) },
    { previous: teamRecord(), current: teamRecord({ status: 'active', revision: 2, updatedAt: 2 }) },
    { previous: teamRecord(), current: teamRecord({ status: 'disabled', displayName: 'Changed', revision: 2, updatedAt: 2 }) },
    { previous: teamRecord(), current: teamRecord({ tenantId: tenantId('other'), status: 'disabled', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent team mutation commit %#', async (commit) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.teamMutationResult = commit
    await expect(teams.disable({ teamId: teamId('team-1'), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    { method: 'disable' as const, previous: teamRecord({ status: 'disabled' }), current: teamRecord({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { method: 'enable' as const, previous: teamRecord({ status: 'active' }), current: teamRecord({ status: 'active', revision: 2, updatedAt: 2 }) },
    { method: 'delete' as const, previous: teamRecord({ status: 'deleted' }), current: teamRecord({ status: 'deleted', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent team status method commit %#', async ({ method, previous, current }) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.teamMutationResult = { previous, current }
    await expect(teams[method]({ teamId: teamId('team-1'), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    undefined,
    { previous: memberRecord({ teamId: teamId('other') }), current: memberRecord({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ userId: userId('other'), status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ membershipId: teamMembershipId('other'), status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord({ revision: 2 }), current: memberRecord({ status: 'disabled', revision: 3, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ status: 'disabled', revision: 3, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ status: 'disabled', createdAt: 2, revision: 2, updatedAt: 2 }) },
    { previous: memberRecord({ updatedAt: 2 }), current: memberRecord({ status: 'disabled', revision: 2, updatedAt: 1 }) },
    { previous: memberRecord({ status: 'removed' }), current: memberRecord({ status: 'removed', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ status: 'active', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ tenantId: tenantId('other'), status: 'disabled', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent membership mutation commit %#', async (commit) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.membershipMutationResult = commit
    await expect(teams.disableMembership({
      teamId: teamId('team-1'),
      userId: userId('user-1'),
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    { method: 'disableMembership' as const, previous: memberRecord({ status: 'disabled' }), current: memberRecord({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { method: 'enableMembership' as const, previous: memberRecord({ status: 'active' }), current: memberRecord({ status: 'active', revision: 2, updatedAt: 2 }) },
    { method: 'removeMembership' as const, previous: memberRecord({ status: 'removed' }), current: memberRecord({ status: 'removed', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent membership status method commit %#', async ({ method, previous, current }) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.membershipMutationResult = { previous, current }
    await expect(teams[method]({
      teamId: teamId('team-1'),
      userId: userId('user-1'),
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    { memberships: 'not-an-array' },
    { memberships: [memberRecord(), memberRecord()] },
    { memberships: [memberRecord({ teamId: teamId('other') })] },
    { memberships: [memberRecord({ status: 'disabled' })] },
    { memberships: [], nextCursor: 1 },
    { memberships: [], nextCursor: '' },
    { memberships: [], nextCursor: 'x'.repeat(1025) },
  ])('rejects malformed Provider membership page %#', async (page) => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.createFailure = undefined
    teams.teamResult = teamRecordWithoutName()
    teams.pageResult = page
    await expect(teams.listMembers({ teamId: teamId('team-1'), limit: 1, status: 'active' }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects a page that repeats the same membership id', async () => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.createFailure = undefined
    teams.teamResult = teamRecordWithoutName()
    teams.pageResult = { memberships: [memberRecord(), memberRecord()] }
    await expect(teams.listMembers({ teamId: teamId('team-1'), limit: 2, status: 'active' }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects a user-scoped page that belongs to another user or tenant', async () => {
    const { teams } = await setup(BrokenTeamDirectory)
    teams.pageResult = { memberships: [memberRecord({ userId: userId('other') })] }
    await expect(teams.listUserTeams({ userId: userId('user-1'), tenantId: tenantId('tenant-1'), limit: 1 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
    teams.pageResult = { memberships: [memberRecord({ tenantId: tenantId('other') })] }
    await expect(teams.listUserTeams({ userId: userId('user-1'), tenantId: tenantId('tenant-1'), limit: 1 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('contains listener failures and still notifies later listeners', async () => {
    const { ctx, teams } = await setup(MemoryTeamDirectory)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const observed = vi.fn()
    ctx.on('team/changed', () => { throw new Error('listener failed') })
    ctx.on('team/changed', observed)

    await expect(teams.create({ tenantId: tenantId('tenant-1') })).resolves.toMatchObject({ status: 'active' })
    expect(observed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
  })

  it('contains asynchronous listener rejection and rethrows invariant failures after fan-out', async () => {
    const { ctx, teams } = await setup(MemoryTeamDirectory)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const observed = vi.fn()
    const asyncListener = (() => Promise.reject(new Error('async listener failed'))) as unknown as () => void
    const nullListener = (() => null) as unknown as () => void
    ctx.on('team/changed', asyncListener)
    ctx.on('team/changed', nullListener)
    await teams.create({ tenantId: tenantId('tenant-1') })
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()

    ctx.on('team/changed', () => { throw Object.assign(new Error('invariant failed'), { code: 'INVARIANT' }) })
    ctx.on('team/changed', observed)
    await expect(teams.create({ tenantId: tenantId('tenant-1') })).rejects.toThrow('invariant failed')
    expect(observed).toHaveBeenCalledOnce()
  })

  it('removes the teams service when the Provider fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryTeamDirectory)
    expect(ctx.get('teams')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('teams')).toBeUndefined()
  })
})

describe('team-directory errors', () => {
  it('preserves stable errors and their causes', () => {
    const cause = new Error('cause')
    const error = new TeamDirectoryError('provider-unavailable', 'safe', { cause })
    expect(error).toMatchObject({ name: 'TeamDirectoryError', code: 'provider-unavailable', message: 'safe', cause })
  })
})
