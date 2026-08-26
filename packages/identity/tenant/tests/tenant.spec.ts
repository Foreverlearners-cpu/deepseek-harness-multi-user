import { Context } from '@deepseek-ai/cordis'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import { describe, expect, it, vi } from 'vitest'
import TenantDirectory, {
  MAX_MEMBERSHIP_LIST_LIMIT,
  MAX_TENANT_DISPLAY_NAME_LENGTH,
  TenantDirectoryError,
  membershipId,
  tenantId,
  type MembershipCreateRecordInput,
  type MembershipListQuery,
  type MembershipMutation,
  type MembershipMutationCommit,
  type MembershipPage,
  type MembershipRecord,
  type TenantCreateRecordInput,
  type TenantId,
  type TenantMutation,
  type TenantMutationCommit,
  type TenantRecord,
} from '../src/index.ts'
import { runTenantDirectoryContract } from './contract.ts'
import { MemoryTenantDirectory } from './memory.ts'

async function setup<T extends TenantDirectory>(Provider: new (ctx: Context) => T): Promise<{ ctx: Context; tenants: T }> {
  const ctx = new Context()
  await ctx.plugin(Provider)
  return { ctx, tenants: ctx.tenants as T }
}

runTenantDirectoryContract('memory', () => setup(MemoryTenantDirectory))

class BrokenTenantDirectory extends TenantDirectory {
  createFailure: Error | undefined
  tenantResult: unknown
  membershipResult: unknown
  tenantMutationResult: unknown
  membershipMutationResult: unknown
  pageResult: unknown

  constructor(ctx: Context) {
    super(ctx)
    this.createFailure = new Error('database password must not escape')
    this.tenantResult = undefined
    this.membershipResult = undefined
    this.tenantMutationResult = undefined
    this.membershipMutationResult = undefined
    this.pageResult = { memberships: [] }
  }

  protected createTenantRecord(_input: TenantCreateRecordInput): Promise<TenantRecord> {
    return this.createFailure === undefined
      ? Promise.resolve(this.tenantResult as TenantRecord)
      : Promise.reject(this.createFailure)
  }

  protected readTenantRecord(_id: TenantId): Promise<TenantRecord | undefined> {
    return Promise.resolve(this.tenantResult as TenantRecord | undefined)
  }

  protected mutateTenantRecord(_mutation: TenantMutation): Promise<TenantMutationCommit> {
    return Promise.resolve(this.tenantMutationResult as TenantMutationCommit)
  }

  protected createMembershipRecord(_input: MembershipCreateRecordInput): Promise<MembershipRecord> {
    return this.createFailure === undefined
      ? Promise.resolve(this.membershipResult as MembershipRecord)
      : Promise.reject(this.createFailure)
  }

  protected readMembershipRecord(_id: TenantId, _member: UserId): Promise<MembershipRecord | undefined> {
    return Promise.resolve(this.membershipResult as MembershipRecord | undefined)
  }

  protected mutateMembershipRecord(_mutation: MembershipMutation): Promise<MembershipMutationCommit> {
    return Promise.resolve(this.membershipMutationResult as MembershipMutationCommit)
  }

  protected listMembershipRecords(_query: MembershipListQuery): Promise<MembershipPage> {
    return Promise.resolve(this.pageResult as MembershipPage)
  }
}

function tenantRecord(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    tenantId: tenantId('tenant-1'),
    displayName: 'Acme',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

function tenantRecordWithoutName(overrides: Partial<Omit<TenantRecord, 'displayName'>> = {}): TenantRecord {
  return {
    tenantId: tenantId('tenant-1'),
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

function memberRecord(overrides: Partial<MembershipRecord> = {}): MembershipRecord {
  return {
    membershipId: membershipId('membership-1'),
    tenantId: tenantId('tenant-1'),
    userId: userId('user-1'),
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

describe('tenant directory validation', () => {
  it('rejects invalid ids, display names, revisions, contexts, and list queries', async () => {
    const { tenants } = await setup(MemoryTenantDirectory)
    expect(() => tenantId('bad id')).toThrow(TypeError)
    expect(() => membershipId('bad id')).toThrow(TypeError)
    await expect(tenants.create({ displayName: '   ' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.create({ displayName: 1 as never })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.create({ displayName: 'x'.repeat(MAX_TENANT_DISPLAY_NAME_LENGTH + 1) }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    const created = await tenants.create()
    await expect(tenants.disable({ tenantId: created.tenantId, expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: 1,
      context: { correlationId: '', reason: '' },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: 1,
      context: { correlationId: 'x'.repeat(129) },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: 1,
      context: { reason: '' },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: 1,
      context: { reason: 'x'.repeat(501) },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: 1,
      context: { actorUserId: 'bad id' as UserId },
    })).rejects.toThrow(TypeError)
    await expect(tenants.listMembers({ tenantId: created.tenantId, limit: 0 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listMembers({ tenantId: created.tenantId, limit: 1.5 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listMembers({ tenantId: created.tenantId, limit: MAX_MEMBERSHIP_LIST_LIMIT + 1 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listMembers({ tenantId: created.tenantId, cursor: '' }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listMembers({ tenantId: created.tenantId, cursor: 1 as never }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listMembers({ tenantId: created.tenantId, cursor: 'x'.repeat(1025) }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listMembers({ tenantId: created.tenantId, status: 'unknown' as never }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.listMembers({ tenantId: tenantId('missing') }))
      .rejects.toMatchObject({ code: 'tenant-not-found' })
    await expect(tenants.listUserMemberships({ userId: userId('user-1'), cursor: 'abc' }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenants.requireActiveMembership(created.tenantId, userId('missing')))
      .rejects.toMatchObject({ code: 'membership-not-found' })
    await expect(tenants.listMembers({ tenantId: created.tenantId, status: 'removed' }))
      .resolves.toMatchObject({ memberships: [] })
  })

  it('accepts empty and partial operation context', async () => {
    const { tenants } = await setup(MemoryTenantDirectory)
    const created = await tenants.create({ context: {} })
    const disabled = await tenants.disable({
      tenantId: created.tenantId,
      expectedRevision: created.revision,
      context: { correlationId: 'request-only' },
    })
    expect(disabled.status).toBe('disabled')
    const enabled = await tenants.enable({
      tenantId: created.tenantId,
      expectedRevision: disabled.revision,
      context: { reason: '  restore  ' },
    })
    expect(enabled.status).toBe('active')
  })

  it('normalizes unexpected Provider failures and malformed Provider records', async () => {
    const { tenants } = await setup(BrokenTenantDirectory)
    await expect(tenants.create()).rejects.toEqual(expect.objectContaining({
      name: 'TenantDirectoryError',
      code: 'provider-unavailable',
      message: 'tenant: directory Provider failed',
    }))
    tenants.createFailure = undefined
    tenants.tenantResult = {
      tenantId: tenantId('tenant-1'),
      status: 'active',
      createdAt: 2,
      updatedAt: 1,
      revision: 1,
    }
    await expect(tenants.create()).rejects.toMatchObject({ code: 'provider-unavailable' })
    await expect(tenants.get(tenantId('tenant-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    Object.create(null),
    tenantRecord({ tenantId: 'bad id' as TenantId }),
    tenantRecord({ status: 'unknown' as never }),
    tenantRecord({ createdAt: -1 }),
    tenantRecord({ updatedAt: -1 }),
    tenantRecord({ revision: 0 }),
    tenantRecord({ displayName: ' Before ' }),
  ])('rejects malformed Provider tenant record %#', async (badRecord) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.tenantResult = badRecord
    await expect(tenants.get(tenantId('tenant-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    tenantRecordWithoutName({ status: 'disabled' }),
    tenantRecordWithoutName({ revision: 2 }),
    tenantRecord({ displayName: 'Unexpected' }),
  ])('rejects invalid initial Provider tenant record %#', async (badRecord) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.createFailure = undefined
    tenants.tenantResult = badRecord
    await expect(tenants.create()).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    memberRecord({ membershipId: 'bad id' as never }),
    memberRecord({ tenantId: 'bad id' as TenantId }),
    memberRecord({ userId: 'bad id' as UserId }),
    memberRecord({ status: 'unknown' as never }),
    memberRecord({ createdAt: -1 }),
    memberRecord({ updatedAt: -1 }),
    memberRecord({ revision: 0 }),
    memberRecord({ createdAt: 2, updatedAt: 1 }),
  ])('rejects malformed Provider membership record %#', async (badRecord) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.membershipResult = badRecord
    await expect(tenants.getMembership(tenantId('tenant-1'), userId('user-1')))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    memberRecord({ status: 'disabled' }),
    memberRecord({ revision: 2 }),
    memberRecord({ tenantId: tenantId('other') }),
    memberRecord({ userId: userId('other') }),
  ])('rejects invalid initial Provider membership record %#', async (badRecord) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.createFailure = undefined
    tenants.tenantResult = tenantRecordWithoutName()
    tenants.membershipResult = badRecord
    await expect(tenants.addMember({ tenantId: tenantId('tenant-1'), userId: userId('user-1') }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    undefined,
    { previous: tenantRecord({ tenantId: tenantId('other') }), current: tenantRecord({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: tenantRecord(), current: tenantRecord({ tenantId: tenantId('other'), status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: tenantRecord({ revision: 2 }), current: tenantRecord({ status: 'disabled', revision: 3, updatedAt: 2 }) },
    { previous: tenantRecord(), current: tenantRecord({ status: 'disabled', revision: 3, updatedAt: 2 }) },
    { previous: tenantRecord(), current: tenantRecord({ status: 'disabled', createdAt: 2, revision: 2, updatedAt: 2 }) },
    { previous: tenantRecord({ updatedAt: 2 }), current: tenantRecord({ status: 'disabled', revision: 2, updatedAt: 1 }) },
    { previous: tenantRecord({ status: 'deleted' }), current: tenantRecord({ status: 'deleted', revision: 2, updatedAt: 2 }) },
    { previous: tenantRecord(), current: tenantRecord({ status: 'active', revision: 2, updatedAt: 2 }) },
    { previous: tenantRecord(), current: tenantRecord({ status: 'disabled', displayName: 'Changed', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent tenant mutation commit %#', async (commit) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.tenantMutationResult = commit
    await expect(tenants.disable({ tenantId: tenantId('tenant-1'), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    { method: 'disable' as const, previous: tenantRecord({ status: 'disabled' }), current: tenantRecord({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { method: 'enable' as const, previous: tenantRecord({ status: 'active' }), current: tenantRecord({ status: 'active', revision: 2, updatedAt: 2 }) },
    { method: 'delete' as const, previous: tenantRecord({ status: 'deleted' }), current: tenantRecord({ status: 'deleted', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent tenant status method commit %#', async ({ method, previous, current }) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.tenantMutationResult = { previous, current }
    await expect(tenants[method]({ tenantId: tenantId('tenant-1'), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    undefined,
    { previous: memberRecord({ tenantId: tenantId('other') }), current: memberRecord({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ userId: userId('other'), status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ membershipId: membershipId('other'), status: 'disabled', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord({ revision: 2 }), current: memberRecord({ status: 'disabled', revision: 3, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ status: 'disabled', revision: 3, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ status: 'disabled', createdAt: 2, revision: 2, updatedAt: 2 }) },
    { previous: memberRecord({ updatedAt: 2 }), current: memberRecord({ status: 'disabled', revision: 2, updatedAt: 1 }) },
    { previous: memberRecord({ status: 'removed' }), current: memberRecord({ status: 'removed', revision: 2, updatedAt: 2 }) },
    { previous: memberRecord(), current: memberRecord({ status: 'active', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent membership mutation commit %#', async (commit) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.membershipMutationResult = commit
    await expect(tenants.disableMembership({
      tenantId: tenantId('tenant-1'),
      userId: userId('user-1'),
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    { method: 'disableMembership' as const, previous: memberRecord({ status: 'disabled' }), current: memberRecord({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { method: 'enableMembership' as const, previous: memberRecord({ status: 'active' }), current: memberRecord({ status: 'active', revision: 2, updatedAt: 2 }) },
    { method: 'removeMembership' as const, previous: memberRecord({ status: 'removed' }), current: memberRecord({ status: 'removed', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent membership status method commit %#', async ({ method, previous, current }) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.membershipMutationResult = { previous, current }
    await expect(tenants[method]({
      tenantId: tenantId('tenant-1'),
      userId: userId('user-1'),
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    { memberships: 'not-an-array' },
    { memberships: [memberRecord(), memberRecord()] },
    { memberships: [memberRecord({ tenantId: tenantId('other') })] },
    { memberships: [memberRecord({ status: 'disabled' })] },
    { memberships: [], nextCursor: 1 },
    { memberships: [], nextCursor: '' },
    { memberships: [], nextCursor: 'x'.repeat(1025) },
  ])('rejects malformed Provider membership page %#', async (page) => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.createFailure = undefined
    tenants.tenantResult = tenantRecordWithoutName()
    tenants.pageResult = page
    await expect(tenants.listMembers({ tenantId: tenantId('tenant-1'), limit: 1, status: 'active' }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects a user-scoped page that belongs to another user', async () => {
    const { tenants } = await setup(BrokenTenantDirectory)
    tenants.pageResult = { memberships: [memberRecord({ userId: userId('other') })] }
    await expect(tenants.listUserMemberships({ userId: userId('user-1'), limit: 1 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('contains listener failures and still notifies later listeners', async () => {
    const { ctx, tenants } = await setup(MemoryTenantDirectory)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const observed = vi.fn()
    ctx.on('tenant/changed', () => { throw new Error('listener failed') })
    ctx.on('tenant/changed', observed)

    await expect(tenants.create()).resolves.toMatchObject({ status: 'active' })
    expect(observed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
  })

  it('contains asynchronous listener rejection and rethrows invariant failures after fan-out', async () => {
    const { ctx, tenants } = await setup(MemoryTenantDirectory)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const observed = vi.fn()
    const asyncListener = (() => Promise.reject(new Error('async listener failed'))) as unknown as () => void
    const nullListener = (() => null) as unknown as () => void
    ctx.on('tenant/changed', asyncListener)
    ctx.on('tenant/changed', nullListener)
    await tenants.create()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()

    ctx.on('tenant/changed', () => { throw Object.assign(new Error('invariant failed'), { code: 'INVARIANT' }) })
    ctx.on('tenant/changed', observed)
    await expect(tenants.create()).rejects.toThrow('invariant failed')
    expect(observed).toHaveBeenCalledOnce()
  })

  it('removes the tenants service when the Provider fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryTenantDirectory)
    expect(ctx.get('tenants')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('tenants')).toBeUndefined()
  })
})

describe('tenant-directory errors', () => {
  it('preserves stable errors and their causes', () => {
    const cause = new Error('cause')
    const error = new TenantDirectoryError('provider-unavailable', 'safe', { cause })
    expect(error).toMatchObject({ name: 'TenantDirectoryError', code: 'provider-unavailable', message: 'safe', cause })
  })
})
