import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Authority, { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import AuthorityAcl, { aclSubjectRef } from '@deepseek-ai/dsh-authority-acl'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { MemoryTeamMembership } from '../../authority-acl/tests/teams-stub.ts'
import AuthorityAclMysql, { AUTHORITY_ACL_MYSQL_SCHEMA_VERSION } from '../src/index.ts'
import { FakeMysql } from './fake-mysql.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')
const EXECUTE = actionCode('plugin:execute')
const READ = actionCode('plugin:read')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')
const OTHER = resourceId('plugin-200')

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

async function setup(mysql = new FakeMysql()): Promise<{
  ctx: Context
  mysql: FakeMysql
  store: AuthorityAclMysql
  teams: MemoryTeamMembership
}> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', mysql.asService())
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  await ctx.plugin(MemoryTeamMembership)
  await ctx.plugin(AuthorityAcl)
  await ctx.plugin(AuthorityAclMysql)
  return {
    ctx,
    mysql,
    store: ctx.authorityAclMysql,
    teams: ctx.get('teams') as unknown as MemoryTeamMembership,
  }
}

const teamGrant = {
  resource: { type: TYPE, id: RESOURCE },
  subject: { kind: 'team' as const, id: TEAM_RD },
  use: [EXECUTE],
  delegate: [] as const,
}

describe('AuthorityAclMysql', () => {
  it('initializes the current schema with a team subject column and rejects incompatible versions', async () => {
    expect(AUTHORITY_ACL_MYSQL_SCHEMA_VERSION).toBe(1)
    const initialized = new FakeMysql()
    await setup(initialized)
    expect(initialized.schemaVersion).toBe(1)
    expect(initialized.grantTableExists).toBe(true)
    const ddl = initialized.queries.find(sql => sql.startsWith('CREATE TABLE dsh_resource_action_grants'))
    expect(ddl).toEqual(expect.stringContaining('PRIMARY KEY (resource_type, resource_id, resource_revision, subject_ref)'))
    expect(ddl).toEqual(expect.stringContaining('resource_revision BIGINT'))
    expect(ddl).toEqual(expect.stringContaining('subject_ref VARCHAR(160)'))

    const existing = new FakeMysql()
    existing.schemaVersion = AUTHORITY_ACL_MYSQL_SCHEMA_VERSION
    existing.grantTableExists = true
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
    unversioned.grantTableExists = true
    await expect(setup(unversioned)).rejects.toThrow(/unversioned acl tables/)

    const missing = new FakeMysql()
    missing.schemaVersion = AUTHORITY_ACL_MYSQL_SCHEMA_VERSION
    await expect(setup(missing)).rejects.toThrow(/versioned acl tables are missing/)
  })

  it('stores a team grant as one g:team row and does not copy members', async () => {
    const { mysql, store, teams } = await setup()
    const created = await store.grant(teamGrant, 1)
    expect(aclSubjectRef(created.subject)).toBe('g:team-rd')
    expect(mysql.grants.size).toBe(1)
    expect([...mysql.grants.values()][0]?.subject_ref).toBe('g:team-rd')
    teams.add(TEAM_RD, USER)
    teams.add(TEAM_RD, userId('user-blue'))
    expect(mysql.grants.size).toBe(1)
    await expect(store.listGrants({ type: TYPE, id: RESOURCE })).resolves.toEqual([{
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'team', id: TEAM_RD },
      use: [EXECUTE],
      delegate: [],
    }])
  })

  it('reads grants by resource and resource revision without mixing slots', async () => {
    const { store } = await setup()
    await store.grant(teamGrant, 1)
    await store.grant({ ...teamGrant, use: [READ] }, 2)
    await store.grant({
      resource: { type: TYPE, id: OTHER },
      subject: { kind: 'everyone' },
      use: [EXECUTE],
      delegate: [],
    }, 1)

    await expect(store.listGrantsAt({ type: TYPE, id: RESOURCE }, 1)).resolves.toMatchObject([{
      resourceRevision: 1,
      use: [EXECUTE],
      subject: { kind: 'team', id: TEAM_RD },
    }])
    await expect(store.listGrantsAt({ type: TYPE, id: RESOURCE }, 2)).resolves.toMatchObject([{
      resourceRevision: 2,
      use: [READ],
    }])
    await expect(store.listGrantsAt({ type: TYPE, id: OTHER }, 1)).resolves.toMatchObject([{
      subject: { kind: 'everyone' },
      use: [EXECUTE],
    }])
    await expect(store.listGrants({ type: TYPE, id: RESOURCE })).resolves.toHaveLength(2)
    await expect(store.listGrants({ type: TYPE, id: OTHER })).resolves.toHaveLength(1)
  })

  it('persists an already-authorized write without calling decide', async () => {
    const { ctx, store } = await setup()
    const decide = vi.spyOn(ctx.authority, 'decide')
    const require = vi.spyOn(ctx.authority, 'require')
    await store.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'user', id: USER },
      use: [],
      delegate: [EXECUTE],
    }, 1)
    expect(decide).not.toHaveBeenCalled()
    expect(require).not.toHaveBeenCalled()
  })

  it('revokes a grant so later lists omit that subject', async () => {
    const { ctx, store, teams } = await setup()
    await store.grant(teamGrant, 1)
    teams.add(TEAM_RD, USER)
    const revoked = await store.revoke({ type: TYPE, id: RESOURCE }, teamGrant.subject, 1)
    expect(revoked).toMatchObject({ status: 'revoked', revision: 2 })
    await expect(store.listGrants({ type: TYPE, id: RESOURCE })).resolves.toEqual([])
    await expect(store.listGrantsAt({ type: TYPE, id: RESOURCE }, 1)).resolves.toEqual([])
    await expect(ctx.authorityAcl.evaluate({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_RD,
        revision: 1,
      },
      set: 'use',
    })).resolves.toEqual({ actions: [] })
    await expect(store.revoke({ type: TYPE, id: RESOURCE }, teamGrant.subject, 1))
      .resolves.toMatchObject({ status: 'revoked', revision: 2 })
    await expect(store.revoke({ type: TYPE, id: RESOURCE }, { kind: 'everyone' }, 1))
      .resolves.toBeUndefined()
  })

  it('reactivates a revoked grant at revision 1 and increments an active rewrite', async () => {
    const { store } = await setup()
    await store.grant(teamGrant, 1)
    await store.revoke({ type: TYPE, id: RESOURCE }, teamGrant.subject, 1)
    const restored = await store.grant({ ...teamGrant, use: [READ] }, 1)
    expect(restored).toMatchObject({ status: 'active', revision: 1, use: [READ] })
    const again = await store.grant(teamGrant, 1)
    expect(again.revision).toBe(2)
  })

  it('maps driver failures without exposing SQL diagnostics', async () => {
    const { mysql, store } = await setup()
    mysql.failNext = new Error('password=secret SELECT * FROM dsh_resource_action_grants')
    await expect(store.listGrants({ type: TYPE, id: RESOURCE })).rejects.toEqual(expect.objectContaining({
      code: 'provider-unavailable',
      message: 'authority-acl-mysql: policy store failed',
    }))
  })

  it('maps rollback failure to unavailable instead of retaining the original conflict', async () => {
    const { mysql, store } = await setup()
    await store.grant(teamGrant, 1)
    mysql.rollbackFailure = new Error('connection lost during rollback')
    mysql.zeroNextUpdate = true
    await expect(store.grant({ ...teamGrant, use: [READ] }, 1))
      .rejects.toMatchObject({
        code: 'provider-unavailable',
        message: 'authority-acl-mysql: transaction rollback failed',
      })
  })

  it('decodes driver BIGINT strings', async () => {
    const { mysql, store } = await setup()
    mysql.grants.set(`${TYPE}\0${RESOURCE}\0${1}\0g:team-rd`, {
      resource_type: TYPE,
      resource_id: RESOURCE,
      resource_revision: '1',
      subject_ref: 'g:team-rd',
      use_actions: ['plugin:execute'],
      delegate_actions: [],
      status: 'active',
      created_at: '5',
      updated_at: '6',
      revision: '7',
    })
    await expect(store.listGrantsAt({ type: TYPE, id: RESOURCE }, 1)).resolves.toMatchObject([{
      resourceRevision: 1,
      revision: 7,
      use: [EXECUTE],
    }])
  })

  it('rejects malformed stored rows as unavailable', async () => {
    const { mysql, store } = await setup()
    mysql.grants.set(`${TYPE}\0${RESOURCE}\0${1}\0g:team-rd`, {
      resource_type: TYPE,
      resource_id: RESOURCE,
      resource_revision: 1,
      subject_ref: 'g:team-rd',
      use_actions: '{',
      delegate_actions: [],
      status: 'active',
      created_at: 1,
      updated_at: 1,
      revision: 1,
    })
    await expect(store.listGrants({ type: TYPE, id: RESOURCE })).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'authority-acl-mysql: stored grant row is invalid',
    })
    mysql.grants.set(`${TYPE}\0${RESOURCE}\0${1}\0g:team-rd`, {
      resource_type: TYPE,
      resource_id: RESOURCE,
      resource_revision: 1,
      subject_ref: 'g:team-rd',
      use_actions: 1,
      delegate_actions: [],
      status: 'active',
      created_at: 1,
      updated_at: 1,
      revision: 1,
    })
    await expect(store.listGrantsAt({ type: TYPE, id: RESOURCE }, 1)).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
    mysql.grants.set(`${TYPE}\0${RESOURCE}\0${1}\0g:team-rd`, {
      resource_type: TYPE,
      resource_id: RESOURCE,
      resource_revision: 1,
      subject_ref: 'g:team-rd',
      use_actions: [1],
      delegate_actions: [],
      status: 'active',
      created_at: 1,
      updated_at: 1,
      revision: Number.MAX_SAFE_INTEGER + 1,
    })
    await expect(store.listGrants({ type: TYPE, id: RESOURCE })).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
    mysql.grants.set(`${TYPE}\0${RESOURCE}\0${1}\0g:team-rd`, {
      resource_type: TYPE,
      resource_id: RESOURCE,
      resource_revision: 1,
      subject_ref: 'g:team-rd',
      use_actions: ['plugin:execute'],
      delegate_actions: [],
      status: 'active',
      created_at: -1,
      updated_at: 1,
      revision: 1,
    })
    await expect(store.listGrants({ type: TYPE, id: RESOURCE })).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it('rejects impossible write counts and missing post-write rows as unavailable', async () => {
    const { mysql, store } = await setup()
    await store.grant(teamGrant, 1)
    mysql.zeroNextUpdate = true
    await expect(store.grant({ ...teamGrant, use: [READ] }, 1))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostWrite = true
    await expect(store.grant({ ...teamGrant, use: [READ] }, 1))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.zeroNextUpdate = true
    await expect(store.revoke({ type: TYPE, id: RESOURCE }, teamGrant.subject, 1))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    await store.revoke({ type: TYPE, id: RESOURCE }, teamGrant.subject, 1)
    mysql.zeroNextUpdate = true
    await expect(store.grant(teamGrant, 1)).rejects.toMatchObject({ code: 'provider-unavailable' })

    await store.grant(teamGrant, 1)
    mysql.hideNextPostWrite = true
    await expect(store.revoke({ type: TYPE, id: RESOURCE }, teamGrant.subject, 1))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostWrite = true
    await expect(store.grant({
      resource: { type: TYPE, id: OTHER },
      subject: { kind: 'everyone' },
      use: [EXECUTE],
      delegate: [],
    }, 1)).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects invalid seeds and maps a duplicate insert failure', async () => {
    const { mysql, store } = await setup()
    await expect(store.grant({ ...teamGrant, resource: { type: 'bad type' as never, id: RESOURCE } }, 1))
      .rejects.toThrow(TypeError)
    await expect(store.grant({ ...teamGrant, use: ['bad action' as never] }, 1))
      .rejects.toThrow(TypeError)
    await expect(store.grant(teamGrant, 0)).rejects.toThrow(TypeError)
    await expect(store.revoke({ type: TYPE, id: RESOURCE }, { kind: 'user', id: 'bad id' as never }, 1))
      .rejects.toThrow(TypeError)
    await expect(store.listGrants({ type: TYPE, id: 'bad id' as never })).rejects.toThrow(TypeError)
    await expect(store.listGrantsAt({ type: TYPE, id: RESOURCE }, 0)).rejects.toThrow(TypeError)

    mysql.failSql = 'INSERT INTO dsh_resource_action_grants'
    await expect(store.grant({
      resource: { type: TYPE, id: OTHER },
      subject: { kind: 'tenant', id: TENANT },
      use: [READ],
      delegate: [],
    }, 1)).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.duplicateNextInsert = true
    await expect(store.grant({
      resource: { type: TYPE, id: OTHER },
      subject: { kind: 'role', id: 'runner' as never },
      use: [READ],
      delegate: [],
    }, 1)).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects a corrupted grant payload discovered after a write lock', async () => {
    const { mysql, store } = await setup()
    await store.grant(teamGrant, 1)
    mysql.corruptNextGrant = true
    await expect(store.grant({ ...teamGrant, use: [READ] }, 1)).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'authority-acl-mysql: stored grant row is invalid',
    })
  })

  it('keeps Use and Delegate separate for a team grant evaluation', async () => {
    const { ctx, store, teams } = await setup()
    await store.grant({ ...teamGrant, use: [], delegate: [EXECUTE] }, 1)
    teams.add(TEAM_RD, USER)
    teams.add(TEAM_OPS, USER)
    const query = {
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_RD,
        revision: 1,
      },
      set: 'use' as const,
    }
    await expect(ctx.authorityAcl.evaluate(query)).resolves.toEqual({ actions: [] })
    await expect(ctx.authorityAcl.evaluate({ ...query, set: 'delegate' }))
      .resolves.toEqual({ actions: [EXECUTE] })
    await expect(ctx.authorityAcl.evaluate({ ...query, teamId: TEAM_OPS, resource: {
      ...query.resource,
      teamId: TEAM_OPS,
    } })).resolves.toEqual({ actions: [] })
  })
})
