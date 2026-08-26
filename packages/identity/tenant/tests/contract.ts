/** Shared tenant-directory Provider conformance suite. */

import type { Context } from '@deepseek-ai/cordis'
import { userId } from '@deepseek-ai/dsh-user'
import { describe, expect, it } from 'vitest'
import type TenantDirectory from '../src/index.ts'
import { tenantId, type TenantChangeEvent, type TenantMembershipChangeEvent } from '../src/index.ts'

/** Fresh Provider service used for one conformance case. */
export interface TenantDirectoryContractHarness {
  readonly ctx: Context
  readonly tenants: TenantDirectory
}

/**
 * Run the shared lifecycle and consistency contract against one Provider.
 * @param label - Provider label used in the test suite name.
 * @param create - factory returning an empty live Provider per test.
 */
export function runTenantDirectoryContract(
  label: string,
  create: () => Promise<TenantDirectoryContractHarness>,
): void {
  describe(`tenant directory contract: ${label}`, () => {
    it('creates stable ids and returns immutable detached records', async () => {
      const { tenants } = await create()
      const first = await tenants.create({ displayName: '  Acme  ' })
      const second = await tenants.create()

      expect(first).toEqual({
        tenantId: 'tenant-1',
        displayName: 'Acme',
        status: 'active',
        createdAt: first.createdAt,
        updatedAt: first.updatedAt,
        revision: 1,
      })
      expect(second.tenantId).toBe('tenant-2')
      expect(second.displayName).toBeUndefined()
      expect(Number.isSafeInteger(first.createdAt)).toBe(true)
      expect(Object.isFrozen(first)).toBe(true)
      expect(await tenants.get(first.tenantId)).toEqual(first)
      expect(await tenants.get(tenantId('missing'))).toBeUndefined()
    })

    it('adds members, re-adds after removal, and redacts display names from events', async () => {
      const { ctx, tenants } = await create()
      const tenantEvents: TenantChangeEvent[] = []
      const membershipEvents: TenantMembershipChangeEvent[] = []
      ctx.on('tenant/changed', (event) => { tenantEvents.push(event) })
      ctx.on('tenant/membership-changed', (event) => { membershipEvents.push(event) })
      const actorUserId = userId('admin-1')
      const tenant = await tenants.create({
        displayName: 'Secret Corp',
        context: { actorUserId, correlationId: 'request-1', reason: 'provision tenant' },
      })
      const member = userId('user-1')
      const added = await tenants.addMember({
        tenantId: tenant.tenantId,
        userId: member,
        context: { actorUserId, correlationId: 'request-2', reason: 'invite member' },
      })

      expect(added).toMatchObject({
        membershipId: 'membership-1',
        tenantId: tenant.tenantId,
        userId: member,
        status: 'active',
        revision: 1,
      })
      expect(await tenants.requireActiveMembership(tenant.tenantId, member)).toEqual(added)
      expect(tenantEvents[0]).toEqual({
        kind: 'created',
        tenantId: tenant.tenantId,
        revision: 1,
        status: 'active',
        time: tenant.updatedAt,
        actorUserId,
        correlationId: 'request-1',
        reason: 'provision tenant',
      })
      expect(membershipEvents[0]).toEqual({
        kind: 'created',
        membershipId: added.membershipId,
        tenantId: tenant.tenantId,
        userId: member,
        revision: 1,
        status: 'active',
        time: added.updatedAt,
        actorUserId,
        correlationId: 'request-2',
        reason: 'invite member',
      })
      expect(JSON.stringify(tenantEvents)).not.toContain('Secret Corp')

      await expect(tenants.addMember({ tenantId: tenant.tenantId, userId: member }))
        .rejects.toMatchObject({ code: 'membership-conflict' })

      const removed = await tenants.removeMembership({
        tenantId: tenant.tenantId,
        userId: member,
        expectedRevision: added.revision,
      })
      expect(removed.status).toBe('removed')
      const readded = await tenants.addMember({ tenantId: tenant.tenantId, userId: member })
      expect(readded.membershipId).toBe('membership-2')
      expect(readded.revision).toBe(1)
      expect(await tenants.getMembership(tenant.tenantId, member)).toEqual(readded)
    })

    it('rejects stale membership mutations atomically without emitting a commit event', async () => {
      const { ctx, tenants } = await create()
      const tenant = await tenants.create()
      const member = userId('user-1')
      const added = await tenants.addMember({ tenantId: tenant.tenantId, userId: member })
      const events: TenantMembershipChangeEvent[] = []
      ctx.on('tenant/membership-changed', (event) => { events.push(event) })
      await tenants.disableMembership({
        tenantId: tenant.tenantId,
        userId: member,
        expectedRevision: added.revision,
      })

      await expect(tenants.disableMembership({
        tenantId: tenant.tenantId,
        userId: member,
        expectedRevision: added.revision,
      })).rejects.toMatchObject({ code: 'revision-conflict' })
      expect((await tenants.getMembership(tenant.tenantId, member))?.status).toBe('disabled')
      expect(events).toHaveLength(1)
    })

    it('enforces tenant and membership lifecycle states', async () => {
      const { tenants } = await create()
      const tenant = await tenants.create()
      expect(await tenants.requireActive(tenant.tenantId)).toEqual(tenant)
      const member = userId('user-1')
      const added = await tenants.addMember({ tenantId: tenant.tenantId, userId: member })

      const disabledMember = await tenants.disableMembership({
        tenantId: tenant.tenantId,
        userId: member,
        expectedRevision: added.revision,
      })
      await expect(tenants.requireActiveMembership(tenant.tenantId, member))
        .rejects.toMatchObject({ code: 'membership-disabled' })
      await expect(tenants.disableMembership({
        tenantId: tenant.tenantId,
        userId: member,
        expectedRevision: disabledMember.revision,
      })).rejects.toMatchObject({ code: 'status-conflict' })

      const enabledMember = await tenants.enableMembership({
        tenantId: tenant.tenantId,
        userId: member,
        expectedRevision: disabledMember.revision,
      })
      const removed = await tenants.removeMembership({
        tenantId: tenant.tenantId,
        userId: member,
        expectedRevision: enabledMember.revision,
      })
      expect(removed).toMatchObject({ status: 'removed', revision: 4 })
      await expect(tenants.requireActiveMembership(tenant.tenantId, member))
        .rejects.toMatchObject({ code: 'membership-removed' })
      await expect(tenants.enableMembership({
        tenantId: tenant.tenantId,
        userId: member,
        expectedRevision: removed.revision,
      })).rejects.toMatchObject({ code: 'membership-removed' })

      const disabledTenant = await tenants.disable({
        tenantId: tenant.tenantId,
        expectedRevision: tenant.revision,
      })
      await expect(tenants.requireActive(tenant.tenantId)).rejects.toMatchObject({ code: 'tenant-disabled' })
      await expect(tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-2') }))
        .rejects.toMatchObject({ code: 'tenant-disabled' })

      const enabledTenant = await tenants.enable({
        tenantId: tenant.tenantId,
        expectedRevision: disabledTenant.revision,
      })
      const deleted = await tenants.delete({
        tenantId: tenant.tenantId,
        expectedRevision: enabledTenant.revision,
      })
      expect(deleted).toMatchObject({ status: 'deleted', revision: 4 })
      await expect(tenants.requireActive(tenant.tenantId)).rejects.toMatchObject({ code: 'tenant-deleted' })
      await expect(tenants.requireActiveMembership(tenant.tenantId, member))
        .rejects.toMatchObject({ code: 'tenant-deleted' })
      await expect(tenants.enable({ tenantId: tenant.tenantId, expectedRevision: deleted.revision }))
        .rejects.toMatchObject({ code: 'tenant-deleted' })
      await expect(tenants.requireActive(tenantId('missing'))).rejects.toMatchObject({ code: 'tenant-not-found' })
      await expect(tenants.requireActiveMembership(enabledTenant.tenantId, userId('missing')))
        .rejects.toMatchObject({ code: 'tenant-deleted' })
    })

    it('lists stable bounded membership pages and filters by status', async () => {
      const { tenants } = await create()
      const tenant = await tenants.create()
      const first = await tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-1') })
      await tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-2') })
      const third = await tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-3') })
      await tenants.disableMembership({
        tenantId: tenant.tenantId,
        userId: third.userId,
        expectedRevision: third.revision,
      })

      const pageOne = await tenants.listMembers({ tenantId: tenant.tenantId, limit: 2 })
      const pageTwo = await tenants.listMembers({
        tenantId: tenant.tenantId,
        limit: 2,
        cursor: pageOne.nextCursor!,
      })
      expect(pageOne.memberships.map(record => record.membershipId)).toEqual(['membership-1', 'membership-2'])
      expect(pageOne.nextCursor).toBe('2')
      expect(pageTwo.memberships.map(record => record.membershipId)).toEqual(['membership-3'])
      expect(pageTwo.nextCursor).toBeUndefined()
      expect((await tenants.listMembers({ tenantId: tenant.tenantId, status: 'active' })).memberships)
        .toHaveLength(2)
      expect((await tenants.listMembers({ tenantId: tenant.tenantId, status: 'disabled' }))
        .memberships.map(record => record.userId)).toEqual([third.userId])
      expect((await tenants.listUserMemberships({ userId: first.userId })).memberships).toEqual([first])
      expect(first.status).toBe('active')
    })
  })
}
