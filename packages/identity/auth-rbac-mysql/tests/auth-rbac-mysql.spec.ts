import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Authority, { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import AuthRbac, { roleId } from '@deepseek-ai/dsh-auth-rbac'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import AuthRbacMysql, { AUTH_RBAC_MYSQL_SCHEMA_VERSION } from '../src/index.ts'
import { FakeMysql } from './fake-mysql.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')
const OTHER_TENANT = tenantId('tenant-2')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')
const RUNNER = roleId('runner')
const VIEWER = roleId('viewer')
const READ = actionCode('plugin:read')
const EXECUTE = actionCode('plugin:execute')

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

async function setup(mysql = new FakeMysql()): Promise<{
  ctx: Context
  mysql: FakeMysql
  store: AuthRbacMysql
}> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', mysql.asService())
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  await ctx.plugin(AuthRbac)
  await ctx.plugin(AuthRbacMysql)
  return { ctx, mysql, store: ctx.authRbacMysql }
}

function query(team: ReturnType<typeof teamId>, tenant = TENANT) {
  return {
    userId: USER,
    tenantId: tenant,
    teamId: team,
    action: EXECUTE,
    resource: {
      type: resourceType('plugin'),
      id: resourceId('plugin-100'),
      tenantId: tenant,
      teamId: team,
      revision: 1,
    },
    set: 'use' as const,
  }
}

async function seedStandard(mysql = new FakeMysql()) {
  const harness = await setup(mysql)
  await harness.store.putRole({ roleId: RUNNER, use: [READ, EXECUTE], delegate: [] })
  await harness.store.putRole({ roleId: VIEWER, use: [READ], delegate: [] })
  await harness.store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER })
  await harness.store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_OPS, roleId: VIEWER })
  return harness
}

describe('AuthRbacMysql', () => {
  it('initializes the current schema with team-scoped bindings and rejects incompatible versions', async () => {
    expect(AUTH_RBAC_MYSQL_SCHEMA_VERSION).toBe(1)
    const initialized = new FakeMysql()
    await setup(initialized)
    expect(initialized.schemaVersion).toBe(1)
    expect(initialized.roleTableExists).toBe(true)
    expect(initialized.bindingTableExists).toBe(true)
    const bindingDdl = initialized.queries.find(sql => sql.startsWith('CREATE TABLE dsh_principal_roles'))
    expect(bindingDdl).toEqual(expect.stringContaining('PRIMARY KEY (user_id, tenant_id, team_id, role_id)'))
    expect(bindingDdl).toEqual(expect.stringContaining('team_id VARCHAR(128)'))
    const grantDdl = initialized.queries.find(sql => sql.startsWith('CREATE TABLE dsh_role_action_grants'))
    expect(grantDdl).toEqual(expect.stringContaining('use_actions JSON'))
    expect(grantDdl).toEqual(expect.stringContaining('delegate_actions JSON'))

    const existing = new FakeMysql()
    existing.schemaVersion = AUTH_RBAC_MYSQL_SCHEMA_VERSION
    existing.roleTableExists = true
    existing.bindingTableExists = true
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
    unversioned.roleTableExists = true
    await expect(setup(unversioned)).rejects.toThrow(/unversioned rbac tables/)

    const missingBindings = new FakeMysql()
    missingBindings.schemaVersion = AUTH_RBAC_MYSQL_SCHEMA_VERSION
    missingBindings.roleTableExists = true
    await expect(setup(missingBindings)).rejects.toThrow(/versioned rbac tables are missing/)

    const missingRoles = new FakeMysql()
    missingRoles.schemaVersion = AUTH_RBAC_MYSQL_SCHEMA_VERSION
    missingRoles.bindingTableExists = true
    await expect(setup(missingRoles)).rejects.toThrow(/versioned rbac tables are missing/)
  })

  it('increments role revision so a later evaluate sees the replaced action set', async () => {
    const { ctx, store } = await seedStandard()
    const first = await store.listRoleActions(RUNNER)
    expect(first).toEqual({ use: [READ, EXECUTE], delegate: [] })
    const updated = await store.putRole({ roleId: RUNNER, use: [READ], delegate: [] })
    expect(updated.revision).toBe(2)
    await expect(ctx.authRbac.evaluate(query(TEAM_RD))).resolves.toEqual({ actions: [READ] })
    await expect(ctx.authRbac.evaluate(query(TEAM_OPS))).resolves.toEqual({ actions: [READ] })
  })

  it('does not mix the same user\'s roles across teams or tenants', async () => {
    const { ctx, store } = await seedStandard()
    await store.assign({ userId: USER, tenantId: OTHER_TENANT, teamId: TEAM_RD, roleId: VIEWER })
    await expect(store.listPrincipalRoles({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
    })).resolves.toEqual([RUNNER])
    await expect(store.listPrincipalRoles({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
    })).resolves.toEqual([VIEWER])
    await expect(store.listPrincipalRoles({
      userId: USER,
      tenantId: OTHER_TENANT,
      teamId: TEAM_RD,
    })).resolves.toEqual([VIEWER])
    await expect(ctx.authRbac.evaluate(query(TEAM_RD))).resolves.toEqual({ actions: [READ, EXECUTE] })
    await expect(ctx.authRbac.evaluate(query(TEAM_RD, OTHER_TENANT))).resolves.toEqual({ actions: [READ] })
  })

  it('revokes a binding so the next evaluate no longer includes that role', async () => {
    const { ctx, store } = await seedStandard()
    const revoked = await store.revoke({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      roleId: RUNNER,
    })
    expect(revoked).toMatchObject({ status: 'revoked', revision: 2 })
    await expect(store.listPrincipalRoles({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
    })).resolves.toEqual([])
    await expect(ctx.authRbac.evaluate(query(TEAM_RD))).resolves.toEqual({ actions: [] })
    await expect(ctx.authRbac.evaluate(query(TEAM_OPS))).resolves.toEqual({ actions: [READ] })
    await expect(store.revoke({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      roleId: RUNNER,
    })).resolves.toMatchObject({ status: 'revoked', revision: 2 })
    await expect(store.revoke({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      roleId: VIEWER,
    })).resolves.toBeUndefined()
  })

  it('reactivates a revoked binding at revision 1 and increments an active re-assign', async () => {
    const { store } = await seedStandard()
    await store.revoke({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER })
    const restored = await store.assign({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      roleId: RUNNER,
    })
    expect(restored).toMatchObject({ status: 'active', revision: 1 })
    const again = await store.assign({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      roleId: RUNNER,
    })
    expect(again.revision).toBe(2)
  })

  it('maps driver failures without exposing SQL diagnostics', async () => {
    const { mysql, store } = await setup()
    mysql.failNext = new Error('password=secret SELECT * FROM dsh_principal_roles')
    await expect(store.listPrincipalRoles({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
    })).rejects.toEqual(expect.objectContaining({
      code: 'provider-unavailable',
      message: 'auth-rbac-mysql: policy store failed',
    }))
  })

  it('maps rollback failure to unavailable instead of retaining the original conflict', async () => {
    const { mysql, store } = await setup()
    await store.putRole({ roleId: RUNNER, use: [READ], delegate: [] })
    mysql.rollbackFailure = new Error('connection lost during rollback')
    mysql.zeroNextUpdate = true
    await expect(store.putRole({ roleId: RUNNER, use: [EXECUTE], delegate: [] }))
      .rejects.toMatchObject({ code: 'provider-unavailable', message: 'auth-rbac-mysql: transaction rollback failed' })
  })

  it('decodes driver BIGINT strings', async () => {
    const { mysql, store } = await setup()
    mysql.roles.set('runner', {
      role_id: 'runner',
      use_actions: ['plugin:read'],
      delegate_actions: [],
      revision: '3',
      updated_at: '4',
    })
    await expect(store.listRoleActions(RUNNER)).resolves.toEqual({
      use: [READ],
      delegate: [],
    })
    mysql.bindings.set(`${USER}\0${TENANT}\0${TEAM_RD}\0${RUNNER}`, {
      user_id: USER,
      tenant_id: TENANT,
      team_id: TEAM_RD,
      role_id: RUNNER,
      status: 'active',
      created_at: '5',
      updated_at: '6',
      revision: '7',
    })
    await expect(store.listPrincipalRoles({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
    })).resolves.toEqual([RUNNER])
  })

  it('rejects malformed stored rows and undefined roles as unavailable', async () => {
    const { mysql, store } = await setup()
    await expect(store.listRoleActions(RUNNER)).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'auth-rbac-mysql: role is not defined',
    })
    mysql.roles.set('runner', {
      role_id: 'runner',
      use_actions: '{',
      delegate_actions: [],
      revision: 1,
      updated_at: 1,
    })
    await expect(store.listRoleActions(RUNNER)).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'auth-rbac-mysql: stored role row is invalid',
    })
    mysql.roles.set('runner', {
      role_id: 'runner',
      use_actions: 1,
      delegate_actions: [],
      revision: 1,
      updated_at: 1,
    })
    await expect(store.listRoleActions(RUNNER)).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'auth-rbac-mysql: stored role row is invalid',
    })
    mysql.roles.set('runner', {
      role_id: 'runner',
      use_actions: [1],
      delegate_actions: [],
      revision: 1,
      updated_at: 1,
    })
    await expect(store.listRoleActions(RUNNER)).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'auth-rbac-mysql: stored role row is invalid',
    })
    mysql.bindings.set(`${USER}\0${TENANT}\0${TEAM_OPS}\0${VIEWER}`, {
      user_id: USER,
      tenant_id: TENANT,
      team_id: TEAM_OPS,
      role_id: 'bad role',
      status: 'active',
      created_at: 1,
      updated_at: 1,
      revision: 1,
    })
    await expect(store.listPrincipalRoles({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
    })).rejects.toThrow(TypeError)
    mysql.roles.set('runner', {
      role_id: 'runner',
      use_actions: ['plugin:read'],
      delegate_actions: [],
      revision: Number.MAX_SAFE_INTEGER + 1,
      updated_at: 1,
    })
    await expect(store.listRoleActions(RUNNER)).rejects.toMatchObject({ code: 'provider-unavailable' })
    mysql.bindings.set(`${USER}\0${TENANT}\0${TEAM_RD}\0${RUNNER}`, {
      user_id: USER,
      tenant_id: TENANT,
      team_id: TEAM_RD,
      role_id: RUNNER,
      status: 'active',
      created_at: 1,
      updated_at: 1,
      revision: Number.MAX_SAFE_INTEGER + 1,
    })
    await expect(store.revoke({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      roleId: RUNNER,
    })).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'auth-rbac-mysql: stored binding row is invalid',
    })
  })

  it('rejects impossible write counts and missing post-write rows as unavailable', async () => {
    const { mysql, store } = await setup()
    await store.putRole({ roleId: RUNNER, use: [READ], delegate: [] })
    mysql.zeroNextUpdate = true
    await expect(store.putRole({ roleId: RUNNER, use: [EXECUTE], delegate: [] }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostWrite = true
    await expect(store.putRole({ roleId: RUNNER, use: [READ], delegate: [] }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    await store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER })
    mysql.zeroNextUpdate = true
    await expect(store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostWrite = true
    await expect(store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.zeroNextUpdate = true
    await expect(store.revoke({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    await store.revoke({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER })
    mysql.zeroNextUpdate = true
    await expect(store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    await store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER })
    mysql.hideNextPostWrite = true
    await expect(store.revoke({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostWrite = true
    await expect(store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_OPS, roleId: VIEWER }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects invalid seeds and maps a non-duplicate insert failure', async () => {
    const { mysql, store } = await setup()
    await expect(store.putRole({ roleId: 'bad role' as never, use: [], delegate: [] }))
      .rejects.toThrow(TypeError)
    await expect(store.putRole({ roleId: RUNNER, use: ['bad action' as never], delegate: [] }))
      .rejects.toThrow(TypeError)
    await expect(store.assign({
      userId: 'bad id' as never,
      tenantId: TENANT,
      teamId: TEAM_RD,
      roleId: RUNNER,
    })).rejects.toThrow(TypeError)
    await expect(store.revoke({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_RD,
      roleId: 'bad role' as never,
    })).rejects.toThrow(TypeError)
    await expect(store.listPrincipalRoles({
      userId: 'bad id' as never,
      tenantId: TENANT,
      teamId: TEAM_RD,
    })).rejects.toThrow(TypeError)
    await expect(store.listRoleActions('bad role' as never)).rejects.toThrow(TypeError)

    mysql.failSql = 'INSERT INTO dsh_role_action_grants'
    await expect(store.putRole({ roleId: VIEWER, use: [READ], delegate: [] }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.duplicateNextRoleInsert = true
    await expect(store.putRole({ roleId: RUNNER, use: [READ], delegate: [] }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('stores empty action sets and keeps Use separate from Delegate', async () => {
    const { ctx, store } = await setup()
    await store.putRole({ roleId: RUNNER, use: [], delegate: [EXECUTE] })
    await store.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER })
    await expect(store.listRoleActions(RUNNER)).resolves.toEqual({ use: [], delegate: [EXECUTE] })
    await expect(ctx.authRbac.evaluate(query(TEAM_RD))).resolves.toEqual({ actions: [] })
    await expect(ctx.authRbac.evaluate({ ...query(TEAM_RD), set: 'delegate' }))
      .resolves.toEqual({ actions: [EXECUTE] })
  })

  it('rejects a corrupted role payload discovered after a write lock', async () => {
    const { mysql, store } = await setup()
    await store.putRole({ roleId: RUNNER, use: [READ], delegate: [] })
    mysql.corruptNextRoleActions = true
    await expect(store.putRole({ roleId: RUNNER, use: [EXECUTE], delegate: [] }))
      .rejects.toMatchObject({
        code: 'provider-unavailable',
        message: 'auth-rbac-mysql: stored role row is invalid',
      })
  })
})
