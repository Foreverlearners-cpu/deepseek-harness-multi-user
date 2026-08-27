import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  TeamDirectoryError,
  teamId,
  teamMembershipId,
  type TeamMembershipChangeEvent,
  type TeamMembershipCreateRecordInput,
  type TeamMembershipListQuery,
  type TeamMembershipStatus,
} from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import TeamMysqlDirectory, { TEAM_MYSQL_SCHEMA_VERSION } from '../src/index.ts'
import { decodeCursor, encodeCursor } from '../src/cursor.ts'
import { FakeMysql } from './fake-mysql.ts'

let teamSequence = 0
let membershipSequence = 0
vi.mock('../src/ids.ts', () => ({
  newTeamId: () => `team-${String(++teamSequence)}`,
  newMembershipId: () => `membership-${String(++membershipSequence)}`,
}))

class ExposedTeamMysqlDirectory extends TeamMysqlDirectory {
  insertMembership(input: TeamMembershipCreateRecordInput) {
    return this.createMembershipRecord(input)
  }
}

const contexts: Context[] = []

beforeEach(() => {
  teamSequence = 0
  membershipSequence = 0
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

async function setup(mysql = new FakeMysql()): Promise<{
  ctx: Context
  mysql: FakeMysql
  teams: ExposedTeamMysqlDirectory
}> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', mysql.asService())
  await ctx.plugin(ExposedTeamMysqlDirectory)
  return { ctx, mysql, teams: ctx.teams as ExposedTeamMysqlDirectory }
}

function teamQuery(overrides: {
  readonly teamId?: ReturnType<typeof teamId>
  readonly status?: TeamMembershipStatus
} = {}): TeamMembershipListQuery {
  return {
    scope: 'team',
    teamId: overrides.teamId ?? teamId('team-1'),
    limit: 50,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  }
}

function userQuery(overrides: {
  readonly status?: TeamMembershipStatus
} = {}): TeamMembershipListQuery {
  return {
    scope: 'user',
    userId: userId('user-1'),
    tenantId: tenantId('tenant-1'),
    limit: 50,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  }
}

describe('TeamMysqlDirectory', () => {
  it('initializes the current schema without action columns and rejects an incompatible version', async () => {
    expect(TEAM_MYSQL_SCHEMA_VERSION).toBe(1)
    const initialized = new FakeMysql()
    await setup(initialized)
    expect(initialized.schemaVersion).toBe(1)
    expect(initialized.teamTableExists).toBe(true)
    expect(initialized.membershipTableExists).toBe(true)
    const membershipDdl = initialized.queries.find(sql => sql.startsWith('CREATE TABLE dsh_team_memberships'))
    expect(membershipDdl).toEqual(expect.stringContaining('PRIMARY KEY (team_id, user_id)'))
    expect(membershipDdl).toEqual(expect.stringContaining('tenant_id VARCHAR(128)'))
    expect(membershipDdl).not.toMatch(/action|permission|role|grant/i)

    const existing = new FakeMysql()
    existing.schemaVersion = TEAM_MYSQL_SCHEMA_VERSION
    existing.teamTableExists = true
    existing.membershipTableExists = true
    await expect(setup(existing)).resolves.toMatchObject({ mysql: existing })

    const mysql = new FakeMysql()
    mysql.schemaVersion = 2
    await expect(setup(mysql)).rejects.toThrow(/incompatible schema version/)

    const duplicated = new FakeMysql()
    duplicated.duplicateSchemaRows = true
    await expect(setup(duplicated)).rejects.toThrow(/incompatible schema version/)
  })

  it('rejects unversioned or incomplete existing schema state', async () => {
    const unversioned = new FakeMysql()
    unversioned.teamTableExists = true
    await expect(setup(unversioned)).rejects.toThrow(/unversioned team tables/)

    const missingMemberships = new FakeMysql()
    missingMemberships.schemaVersion = TEAM_MYSQL_SCHEMA_VERSION
    missingMemberships.teamTableExists = true
    await expect(setup(missingMemberships)).rejects.toThrow(/versioned team tables are missing/)

    const missingTeams = new FakeMysql()
    missingTeams.schemaVersion = TEAM_MYSQL_SCHEMA_VERSION
    missingTeams.membershipTableExists = true
    await expect(setup(missingTeams)).rejects.toThrow(/versioned team tables are missing/)
  })

  it('binds keyset cursors to status, scope, and tenant', () => {
    const cursor = encodeCursor(teamMembershipId('membership-4'), teamQuery({ status: 'active' }))
    expect(decodeCursor(cursor, teamQuery({ status: 'active' }))).toBe('membership-4')
    expect(() => decodeCursor(cursor, teamQuery({ status: 'disabled' }))).toThrow(/invalid or mismatched/)
    expect(() => decodeCursor(cursor, userQuery({ status: 'active' }))).toThrow(/invalid or mismatched/)
    expect(() => decodeCursor(cursor, teamQuery({
      status: 'active',
      teamId: teamId('team-2'),
    }))).toThrow(/invalid or mismatched/)
    expect(() => decodeCursor('not-json', teamQuery())).toThrow(/invalid or mismatched/)
    const unfiltered = encodeCursor(teamMembershipId('membership-5'), teamQuery())
    expect(decodeCursor(unfiltered, teamQuery())).toBe('membership-5')
    const userCursor = encodeCursor(teamMembershipId('membership-6'), userQuery({ status: 'active' }))
    expect(decodeCursor(userCursor, userQuery({ status: 'active' }))).toBe('membership-6')
    const wrongVersion = Buffer.from(JSON.stringify({
      v: 2,
      after: 'membership-5',
      status: null,
      scope: 'team',
      scopeId: 'team-1',
      tenantId: null,
    })).toString('base64url')
    expect(() => decodeCursor(wrongVersion, teamQuery())).toThrow(/invalid or mismatched/)
    for (const invalid of [null, [], 'scalar', {
      v: 1,
      after: 4,
      status: null,
      scope: 'team',
      scopeId: 'team-1',
      tenantId: null,
    }]) {
      const encoded = Buffer.from(JSON.stringify(invalid)).toString('base64url')
      expect(() => decodeCursor(encoded, teamQuery())).toThrow(/invalid or mismatched/)
    }
  })

  it('reports malformed and filter-mismatched cursors as invalid input', async () => {
    const { teams } = await setup()
    const owner = tenantId('tenant-1')
    const team = await teams.create({ tenantId: owner })
    const cursor = encodeCursor(teamMembershipId('membership-4'), {
      scope: 'team',
      teamId: team.teamId,
      status: 'active',
      limit: 50,
    })

    await expect(teams.listMembers({
      teamId: team.teamId,
      status: 'disabled',
      cursor,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listMembers({
      teamId: team.teamId,
      cursor: 'not-json',
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(teams.listUserTeams({
      userId: userId('user-1'),
      tenantId: owner,
      cursor,
    })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('maps driver failures without exposing SQL diagnostics', async () => {
    const { mysql, teams } = await setup()
    mysql.failNext = new Error('password=secret SELECT * FROM dsh_teams')

    await expect(teams.get(teamId('team-1'))).rejects.toEqual(expect.objectContaining({
      code: 'provider-unavailable',
      message: 'team: directory Provider failed',
    }))
  })

  it('rolls back a failed kick so revision and membership stay unchanged', async () => {
    const { ctx, mysql, teams } = await setup()
    const owner = tenantId('tenant-1')
    const team = await teams.create({ tenantId: owner })
    const added = await teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })
    const events: TeamMembershipChangeEvent[] = []
    ctx.on('team/membership-changed', (event) => { events.push(event) })
    mysql.failNext = new Error('kick unavailable')

    await expect(teams.removeMembership({
      teamId: team.teamId,
      userId: added.userId,
      expectedRevision: added.revision,
    })).rejects.toBeInstanceOf(TeamDirectoryError)
    expect(await teams.getMembership(team.teamId, added.userId)).toEqual(added)
    expect(events).toHaveLength(0)
  })

  it('maps rollback failure to unavailable instead of retaining an expected conflict', async () => {
    const { mysql, teams } = await setup()
    const owner = tenantId('tenant-1')
    const created = await teams.create({ tenantId: owner })
    mysql.rollbackFailure = new Error('connection lost during rollback')

    await expect(teams.disable({
      teamId: created.teamId,
      expectedRevision: created.revision + 1,
    })).rejects.toMatchObject({ code: 'provider-unavailable', message: 'team-mysql: transaction rollback failed' })
  })

  it('decodes driver BIGINT strings', async () => {
    const { mysql, teams } = await setup()
    mysql.teams.set('team-1', {
      team_id: 'team-1',
      tenant_id: 'tenant-1',
      display_name: 'Stored',
      status: 'active',
      created_at: '1',
      updated_at: '2',
      revision: '3',
    })

    await expect(teams.get(teamId('team-1'))).resolves.toMatchObject({
      createdAt: 1,
      updatedAt: 2,
      revision: 3,
      displayName: 'Stored',
      tenantId: 'tenant-1',
    })

    mysql.memberships.set('team-1\0user-1', {
      team_id: 'team-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      membership_id: 'membership-9',
      status: 'active',
      created_at: '4',
      updated_at: '5',
      revision: '6',
    })
    await expect(teams.getMembership(teamId('team-1'), userId('user-1'))).resolves.toMatchObject({
      createdAt: 4,
      updatedAt: 5,
      revision: 6,
    })
  })

  it('rejects malformed database numerics as unavailable Provider state', async () => {
    const { mysql, teams } = await setup()
    mysql.teams.set('team-1', {
      team_id: 'team-1',
      tenant_id: 'tenant-1',
      display_name: null,
      status: 'active',
      created_at: 1,
      updated_at: 1,
      revision: Number.MAX_SAFE_INTEGER + 1,
    })

    await expect(teams.get(teamId('team-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('locks team then membership when adding a member and continues a filtered keyset', async () => {
    const { mysql, teams } = await setup()
    const owner = tenantId('tenant-1')
    const team = await teams.create({ tenantId: owner })
    const first = await teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })
    const second = await teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-2'),
    })
    const third = await teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-3'),
    })
    const teamLock = mysql.queries.findIndex(sql =>
      sql.includes('FROM dsh_teams WHERE team_id = ? FOR UPDATE'))
    const membershipLock = mysql.queries.findIndex(sql =>
      sql.includes('FROM dsh_team_memberships') && sql.includes('FOR UPDATE'))
    expect(teamLock).toBeGreaterThan(-1)
    expect(membershipLock).toBeGreaterThan(teamLock)

    await teams.disableMembership({
      teamId: team.teamId,
      userId: third.userId,
      expectedRevision: third.revision,
    })
    const page = await teams.listMembers({ teamId: team.teamId, status: 'active', limit: 1 })
    expect(page.memberships.map(record => record.membershipId)).toEqual([first.membershipId])
    await expect(teams.listMembers({
      teamId: team.teamId,
      status: 'active',
      limit: 1,
      cursor: page.nextCursor!,
    })).resolves.toMatchObject({ memberships: [expect.objectContaining({ membershipId: second.membershipId })] })
    await expect(teams.listUserTeams({ userId: first.userId, tenantId: owner }))
      .resolves.toMatchObject({ memberships: [expect.objectContaining({ userId: first.userId })] })
  })

  it('rejects a Provider insert whose tenant does not own the locked team', async () => {
    const { mysql, teams } = await setup()
    const home = tenantId('tenant-1')
    const other = tenantId('tenant-2')
    const team = await teams.create({ tenantId: home })

    await expect(teams.insertMembership({
      teamId: team.teamId,
      tenantId: other,
      userId: userId('user-1'),
    })).rejects.toMatchObject({ code: 'tenant-mismatch' })
    expect(await teams.getMembership(team.teamId, userId('user-1'))).toBeUndefined()
    expect(mysql.memberships.size).toBe(0)
  })

  it('rejects impossible update counts and missing post-update rows as unavailable', async () => {
    const { mysql, teams } = await setup()
    const created = await teams.create({ tenantId: tenantId('tenant-1') })
    mysql.zeroNextUpdate = true
    await expect(teams.disable({
      teamId: created.teamId,
      expectedRevision: created.revision,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostUpdate = true
    await expect(teams.disable({
      teamId: created.teamId,
      expectedRevision: created.revision,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects impossible membership updates and missing post-write rows as unavailable', async () => {
    const { mysql, teams } = await setup()
    const owner = tenantId('tenant-1')
    const team = await teams.create({ tenantId: owner })
    const added = await teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })
    mysql.zeroNextUpdate = true
    await expect(teams.disableMembership({
      teamId: team.teamId,
      userId: added.userId,
      expectedRevision: added.revision,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostUpdate = true
    await expect(teams.disableMembership({
      teamId: team.teamId,
      userId: added.userId,
      expectedRevision: added.revision,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    const removed = await teams.removeMembership({
      teamId: team.teamId,
      userId: added.userId,
      expectedRevision: added.revision,
    })
    expect(removed.status).toBe('removed')
    mysql.zeroNextUpdate = true
    await expect(teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: added.userId,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextMembershipRead = true
    await expect(teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-2'),
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('maps missing rows and raced team or membership slots to directory failures', async () => {
    const { mysql, teams } = await setup()
    const owner = tenantId('tenant-1')
    const team = await teams.create({ tenantId: owner })
    await expect(teams.disable({ teamId: teamId('missing'), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'team-not-found' })
    await expect(teams.disableMembership({
      teamId: team.teamId,
      userId: userId('missing'),
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'membership-not-found' })

    mysql.emptyTeamOnLock = true
    await expect(teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })).rejects.toMatchObject({ code: 'team-not-found' })

    mysql.lockTeamStatus = 'disabled'
    await expect(teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })).rejects.toMatchObject({ code: 'team-disabled' })

    mysql.lockTeamStatus = 'deleted'
    await expect(teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })).rejects.toMatchObject({ code: 'team-deleted' })

    mysql.lockTeamTenantId = 'tenant-other'
    await expect(teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })).rejects.toMatchObject({ code: 'tenant-mismatch' })

    mysql.duplicateNextMembershipInsert = true
    await expect(teams.addMember({
      teamId: team.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })).rejects.toMatchObject({ code: 'membership-conflict' })
  })

  it('rejects illegal team and membership transitions and a non-duplicate insert failure', async () => {
    const { mysql, teams } = await setup()
    const owner = tenantId('tenant-1')
    const team = await teams.create({ tenantId: owner })
    await expect(teams.enable({ teamId: team.teamId, expectedRevision: team.revision }))
      .rejects.toMatchObject({ code: 'status-conflict' })
    const disabled = await teams.disable({
      teamId: team.teamId,
      expectedRevision: team.revision,
    })
    await expect(teams.disable({ teamId: team.teamId, expectedRevision: disabled.revision }))
      .rejects.toMatchObject({ code: 'status-conflict' })
    const deleted = await teams.delete({
      teamId: team.teamId,
      expectedRevision: disabled.revision,
    })
    expect(deleted.status).toBe('deleted')
    expect(await teams.getMembership(team.teamId, userId('never-added'))).toBeUndefined()

    const other = await teams.create({ tenantId: owner })
    const added = await teams.addMember({
      teamId: other.teamId,
      tenantId: owner,
      userId: userId('user-1'),
    })
    const disabledMember = await teams.disableMembership({
      teamId: other.teamId,
      userId: added.userId,
      expectedRevision: added.revision,
    })
    await expect(teams.removeMembership({
      teamId: other.teamId,
      userId: added.userId,
      expectedRevision: disabledMember.revision,
    })).resolves.toMatchObject({ status: 'removed' })

    mysql.failSql = 'INSERT INTO dsh_team_memberships'
    await expect(teams.addMember({
      teamId: other.teamId,
      tenantId: owner,
      userId: userId('user-2'),
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })
})
