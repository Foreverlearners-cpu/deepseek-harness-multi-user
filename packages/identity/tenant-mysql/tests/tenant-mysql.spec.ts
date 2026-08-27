import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  TenantDirectoryError,
  membershipId,
  tenantId,
  type MembershipListQuery,
  type MembershipStatus,
} from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import TenantMysqlDirectory, { TENANT_MYSQL_SCHEMA_VERSION } from '../src/index.ts'
import { decodeCursor, encodeCursor } from '../src/cursor.ts'
import { FakeMysql } from './fake-mysql.ts'

let tenantSequence = 0
let membershipSequence = 0
vi.mock('../src/ids.ts', () => ({
  newTenantId: () => `tenant-${String(++tenantSequence)}`,
  newMembershipId: () => `membership-${String(++membershipSequence)}`,
}))

const contexts: Context[] = []

beforeEach(() => {
  tenantSequence = 0
  membershipSequence = 0
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

async function setup(mysql = new FakeMysql()): Promise<{
  ctx: Context
  mysql: FakeMysql
  tenants: TenantMysqlDirectory
}> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', mysql.asService())
  await ctx.plugin(TenantMysqlDirectory)
  return { ctx, mysql, tenants: ctx.tenants as TenantMysqlDirectory }
}

function tenantQuery(overrides: {
  readonly tenantId?: ReturnType<typeof tenantId>
  readonly status?: MembershipStatus
} = {}): MembershipListQuery {
  return {
    scope: 'tenant',
    tenantId: overrides.tenantId ?? tenantId('tenant-1'),
    limit: 50,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  }
}

function userQuery(overrides: {
  readonly status?: MembershipStatus
} = {}): MembershipListQuery {
  return {
    scope: 'user',
    userId: userId('user-1'),
    limit: 50,
    ...(overrides.status === undefined ? {} : { status: overrides.status }),
  }
}

describe('TenantMysqlDirectory', () => {
  it('initializes the current schema and rejects an incompatible version', async () => {
    expect(TENANT_MYSQL_SCHEMA_VERSION).toBe(1)
    const initialized = new FakeMysql()
    await setup(initialized)
    expect(initialized.schemaVersion).toBe(1)
    expect(initialized.tenantTableExists).toBe(true)
    expect(initialized.membershipTableExists).toBe(true)
    expect(initialized.queries).toContainEqual(expect.stringContaining(
      'display_name VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    ))
    expect(initialized.queries).toContainEqual(expect.stringContaining(
      'PRIMARY KEY (tenant_id, user_id)',
    ))

    const existing = new FakeMysql()
    existing.schemaVersion = TENANT_MYSQL_SCHEMA_VERSION
    existing.tenantTableExists = true
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
    unversioned.tenantTableExists = true
    await expect(setup(unversioned)).rejects.toThrow(/unversioned tenant tables/)

    const missingMemberships = new FakeMysql()
    missingMemberships.schemaVersion = TENANT_MYSQL_SCHEMA_VERSION
    missingMemberships.tenantTableExists = true
    await expect(setup(missingMemberships)).rejects.toThrow(/versioned tenant tables are missing/)

    const missingTenants = new FakeMysql()
    missingTenants.schemaVersion = TENANT_MYSQL_SCHEMA_VERSION
    missingTenants.membershipTableExists = true
    await expect(setup(missingTenants)).rejects.toThrow(/versioned tenant tables are missing/)
  })

  it('binds keyset cursors to status, scope, and scope id', () => {
    const cursor = encodeCursor(membershipId('membership-4'), tenantQuery({ status: 'active' }))
    expect(decodeCursor(cursor, tenantQuery({ status: 'active' }))).toBe('membership-4')
    expect(() => decodeCursor(cursor, tenantQuery({ status: 'disabled' }))).toThrow(/invalid or mismatched/)
    expect(() => decodeCursor(cursor, userQuery({ status: 'active' }))).toThrow(/invalid or mismatched/)
    expect(() => decodeCursor(cursor, tenantQuery({
      status: 'active',
      tenantId: tenantId('tenant-2'),
    }))).toThrow(/invalid or mismatched/)
    expect(() => decodeCursor('not-json', tenantQuery())).toThrow(/invalid or mismatched/)
    const unfiltered = encodeCursor(membershipId('membership-5'), tenantQuery())
    expect(decodeCursor(unfiltered, tenantQuery())).toBe('membership-5')
    const userCursor = encodeCursor(membershipId('membership-6'), userQuery({ status: 'active' }))
    expect(decodeCursor(userCursor, userQuery({ status: 'active' }))).toBe('membership-6')
    const wrongVersion = Buffer.from(JSON.stringify({
      v: 2,
      after: 'membership-5',
      status: null,
      scope: 'tenant',
      scopeId: 'tenant-1',
    })).toString('base64url')
    expect(() => decodeCursor(wrongVersion, tenantQuery())).toThrow(/invalid or mismatched/)
    for (const invalid of [null, [], 'scalar', { v: 1, after: 4, status: null, scope: 'tenant', scopeId: 'tenant-1' }]) {
      const encoded = Buffer.from(JSON.stringify(invalid)).toString('base64url')
      expect(() => decodeCursor(encoded, tenantQuery())).toThrow(/invalid or mismatched/)
    }
  })

  it('reports malformed and filter-mismatched cursors as invalid input', async () => {
    const { tenants } = await setup()
    const tenant = await tenants.create()
    const cursor = encodeCursor(membershipId('membership-4'), {
      scope: 'tenant',
      tenantId: tenant.tenantId,
      status: 'active',
      limit: 50,
    })

    await expect(tenants.listMembers({
      tenantId: tenant.tenantId,
      status: 'disabled',
      cursor,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listMembers({
      tenantId: tenant.tenantId,
      cursor: 'not-json',
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listUserMemberships({
      userId: userId('user-1'),
      cursor,
    })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('maps driver failures without exposing SQL diagnostics', async () => {
    const { mysql, tenants } = await setup()
    mysql.failNext = new Error('password=secret SELECT * FROM dsh_tenants')

    await expect(tenants.get(tenantId('tenant-1'))).rejects.toEqual(expect.objectContaining({
      code: 'provider-unavailable',
      message: 'tenant: directory Provider failed',
    }))
  })

  it('rolls back a failed mutation and preserves the committed record', async () => {
    const { mysql, tenants } = await setup()
    const created = await tenants.create({ displayName: 'Before' })
    mysql.failNext = new Error('update unavailable')

    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: created.revision,
    })).rejects.toBeInstanceOf(TenantDirectoryError)
    expect(await tenants.get(created.tenantId)).toEqual(created)
  })

  it('maps rollback failure to unavailable instead of retaining an expected conflict', async () => {
    const { mysql, tenants } = await setup()
    const created = await tenants.create()
    mysql.rollbackFailure = new Error('connection lost during rollback')

    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: created.revision + 1,
    })).rejects.toMatchObject({ code: 'provider-unavailable', message: 'tenant-mysql: transaction rollback failed' })
  })

  it('decodes driver BIGINT strings', async () => {
    const { mysql, tenants } = await setup()
    mysql.tenants.set('tenant-1', {
      tenant_id: 'tenant-1',
      display_name: 'Stored',
      status: 'active',
      created_at: '1',
      updated_at: '2',
      revision: '3',
    })

    await expect(tenants.get(tenantId('tenant-1'))).resolves.toMatchObject({
      createdAt: 1,
      updatedAt: 2,
      revision: 3,
      displayName: 'Stored',
    })

    mysql.memberships.set('tenant-1\0user-1', {
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      membership_id: 'membership-9',
      status: 'active',
      created_at: '4',
      updated_at: '5',
      revision: '6',
    })
    await expect(tenants.getMembership(tenantId('tenant-1'), userId('user-1'))).resolves.toMatchObject({
      createdAt: 4,
      updatedAt: 5,
      revision: 6,
    })
  })

  it('rejects malformed database numerics as unavailable Provider state', async () => {
    const { mysql, tenants } = await setup()
    mysql.tenants.set('tenant-1', {
      tenant_id: 'tenant-1',
      display_name: null,
      status: 'active',
      created_at: 1,
      updated_at: 1,
      revision: Number.MAX_SAFE_INTEGER + 1,
    })

    await expect(tenants.get(tenantId('tenant-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('locks tenant then membership when adding a member and continues a filtered keyset', async () => {
    const { mysql, tenants } = await setup()
    const tenant = await tenants.create()
    const first = await tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-1') })
    const second = await tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-2') })
    const third = await tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-3') })
    const tenantLock = mysql.queries.findIndex(sql =>
      sql.includes('FROM dsh_tenants WHERE tenant_id = ? FOR UPDATE'))
    const membershipLock = mysql.queries.findIndex(sql =>
      sql.includes('FROM dsh_tenant_memberships') && sql.includes('FOR UPDATE'))
    expect(tenantLock).toBeGreaterThan(-1)
    expect(membershipLock).toBeGreaterThan(tenantLock)

    await tenants.disableMembership({
      tenantId: tenant.tenantId,
      userId: third.userId,
      expectedRevision: third.revision,
    })
    const page = await tenants.listMembers({ tenantId: tenant.tenantId, status: 'active', limit: 1 })
    expect(page.memberships.map(record => record.membershipId)).toEqual([first.membershipId])
    await expect(tenants.listMembers({
      tenantId: tenant.tenantId,
      status: 'active',
      limit: 1,
      cursor: page.nextCursor!,
    })).resolves.toMatchObject({ memberships: [expect.objectContaining({ membershipId: second.membershipId })] })
    await expect(tenants.listUserMemberships({ userId: first.userId }))
      .resolves.toMatchObject({ memberships: [expect.objectContaining({ userId: first.userId })] })
  })

  it('rejects impossible update counts and missing post-update rows as unavailable', async () => {
    const { mysql, tenants } = await setup()
    const created = await tenants.create()
    mysql.zeroNextUpdate = true
    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: created.revision,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostUpdate = true
    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: created.revision,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects impossible membership updates and missing post-write rows as unavailable', async () => {
    const { mysql, tenants } = await setup()
    const tenant = await tenants.create()
    const added = await tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-1') })
    mysql.zeroNextUpdate = true
    await expect(tenants.disableMembership({
      tenantId: tenant.tenantId,
      userId: added.userId,
      expectedRevision: added.revision,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostUpdate = true
    await expect(tenants.disableMembership({
      tenantId: tenant.tenantId,
      userId: added.userId,
      expectedRevision: added.revision,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    const removed = await tenants.removeMembership({
      tenantId: tenant.tenantId,
      userId: added.userId,
      expectedRevision: added.revision,
    })
    expect(removed.status).toBe('removed')
    mysql.zeroNextUpdate = true
    await expect(tenants.addMember({ tenantId: tenant.tenantId, userId: added.userId }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextMembershipRead = true
    await expect(tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-2') }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('maps missing rows and raced tenant or membership slots to directory failures', async () => {
    const { mysql, tenants } = await setup()
    const tenant = await tenants.create()
    await expect(tenants.disable({ tenantId: tenantId('missing'), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'tenant-not-found' })
    await expect(tenants.disableMembership({
      tenantId: tenant.tenantId,
      userId: userId('missing'),
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'membership-not-found' })

    mysql.emptyTenantOnLock = true
    await expect(tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-1') }))
      .rejects.toMatchObject({ code: 'tenant-not-found' })

    mysql.lockTenantStatus = 'disabled'
    await expect(tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-1') }))
      .rejects.toMatchObject({ code: 'tenant-disabled' })

    mysql.lockTenantStatus = 'deleted'
    await expect(tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-1') }))
      .rejects.toMatchObject({ code: 'tenant-deleted' })

    mysql.duplicateNextMembershipInsert = true
    await expect(tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-1') }))
      .rejects.toMatchObject({ code: 'membership-conflict' })
  })

  it('rejects illegal tenant and membership transitions and a non-duplicate insert failure', async () => {
    const { mysql, tenants } = await setup()
    const tenant = await tenants.create()
    await expect(tenants.enable({ tenantId: tenant.tenantId, expectedRevision: tenant.revision }))
      .rejects.toMatchObject({ code: 'status-conflict' })
    const disabled = await tenants.disable({
      tenantId: tenant.tenantId,
      expectedRevision: tenant.revision,
    })
    await expect(tenants.disable({ tenantId: tenant.tenantId, expectedRevision: disabled.revision }))
      .rejects.toMatchObject({ code: 'status-conflict' })
    const deleted = await tenants.delete({
      tenantId: tenant.tenantId,
      expectedRevision: disabled.revision,
    })
    expect(deleted.status).toBe('deleted')
    expect(await tenants.getMembership(tenant.tenantId, userId('never-added'))).toBeUndefined()

    const other = await tenants.create()
    const added = await tenants.addMember({ tenantId: other.tenantId, userId: userId('user-1') })
    const disabledMember = await tenants.disableMembership({
      tenantId: other.tenantId,
      userId: added.userId,
      expectedRevision: added.revision,
    })
    await expect(tenants.removeMembership({
      tenantId: other.tenantId,
      userId: added.userId,
      expectedRevision: disabledMember.revision,
    })).resolves.toMatchObject({ status: 'removed' })

    mysql.failSql = 'INSERT INTO dsh_tenant_memberships'
    await expect(tenants.addMember({ tenantId: other.tenantId, userId: userId('user-2') }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })
})
