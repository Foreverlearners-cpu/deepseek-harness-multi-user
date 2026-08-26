/** Shared team-directory Provider conformance suite. */

import type { Context } from '@deepseek-ai/cordis'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { describe, expect, it } from 'vitest'
import type TeamDirectory from '../src/index.ts'
import { teamId, type TeamChangeEvent, type TeamMembershipChangeEvent } from '../src/index.ts'

/** Fresh Provider service used for one conformance case. */
export interface TeamDirectoryContractHarness {
  readonly ctx: Context
  readonly teams: TeamDirectory
}

/**
 * Run the shared lifecycle and consistency contract against one Provider.
 * @param label - Provider label used in the test suite name.
 * @param create - factory returning an empty live Provider per test.
 */
export function runTeamDirectoryContract(
  label: string,
  create: () => Promise<TeamDirectoryContractHarness>,
): void {
  describe(`team directory contract: ${label}`, () => {
    it('creates stable ids bound to one tenant and returns immutable detached records', async () => {
      const { teams } = await create()
      const owner = tenantId('tenant-1')
      const first = await teams.create({ tenantId: owner, displayName: '  Platform  ' })
      const second = await teams.create({ tenantId: owner })

      expect(first).toEqual({
        teamId: 'team-1',
        tenantId: owner,
        displayName: 'Platform',
        status: 'active',
        createdAt: first.createdAt,
        updatedAt: first.updatedAt,
        revision: 1,
      })
      expect(second.teamId).toBe('team-2')
      expect(second.tenantId).toBe(owner)
      expect(second.displayName).toBeUndefined()
      expect(Number.isSafeInteger(first.createdAt)).toBe(true)
      expect(Object.isFrozen(first)).toBe(true)
      expect(await teams.get(first.teamId)).toEqual(first)
      expect(await teams.get(teamId('missing'))).toBeUndefined()
    })

    it('adds members, re-adds after revoke, and redacts display names from events', async () => {
      const { ctx, teams } = await create()
      const teamEvents: TeamChangeEvent[] = []
      const membershipEvents: TeamMembershipChangeEvent[] = []
      ctx.on('team/changed', (event) => { teamEvents.push(event) })
      ctx.on('team/membership-changed', (event) => { membershipEvents.push(event) })
      const actorUserId = userId('admin-1')
      const owner = tenantId('tenant-1')
      const team = await teams.create({
        tenantId: owner,
        displayName: 'Secret Squad',
        context: { actorUserId, correlationId: 'request-1', reason: 'provision team' },
      })
      const member = userId('user-1')
      const added = await teams.addMember({
        teamId: team.teamId,
        tenantId: owner,
        userId: member,
        context: { actorUserId, correlationId: 'request-2', reason: 'invite member' },
      })

      expect(added).toMatchObject({
        membershipId: 'membership-1',
        teamId: team.teamId,
        tenantId: owner,
        userId: member,
        status: 'active',
        revision: 1,
      })
      expect(await teams.requireActiveMembership(team.teamId, member)).toEqual(added)
      expect(teamEvents[0]).toEqual({
        kind: 'created',
        teamId: team.teamId,
        tenantId: owner,
        revision: 1,
        status: 'active',
        time: team.updatedAt,
        actorUserId,
        correlationId: 'request-1',
        reason: 'provision team',
      })
      expect(membershipEvents[0]).toEqual({
        kind: 'created',
        membershipId: added.membershipId,
        teamId: team.teamId,
        tenantId: owner,
        userId: member,
        revision: 1,
        status: 'active',
        time: added.updatedAt,
        actorUserId,
        correlationId: 'request-2',
        reason: 'invite member',
      })
      expect(JSON.stringify(teamEvents)).not.toContain('Secret Squad')

      await expect(teams.addMember({ teamId: team.teamId, tenantId: owner, userId: member }))
        .rejects.toMatchObject({ code: 'membership-conflict' })

      const removed = await teams.removeMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: added.revision,
      })
      expect(removed.status).toBe('removed')
      expect(membershipEvents.at(-1)).toMatchObject({ kind: 'status-changed', status: 'removed' })
      const readded = await teams.addMember({ teamId: team.teamId, tenantId: owner, userId: member })
      expect(readded.membershipId).toBe('membership-2')
      expect(readded.revision).toBe(1)
      expect(await teams.getMembership(team.teamId, member)).toEqual(readded)
    })

    it('keeps one user in several teams of the same tenant', async () => {
      const { teams } = await create()
      const owner = tenantId('tenant-1')
      const member = userId('user-1')
      const alpha = await teams.create({ tenantId: owner, displayName: 'Alpha' })
      const beta = await teams.create({ tenantId: owner, displayName: 'Beta' })
      await teams.addMember({ teamId: alpha.teamId, tenantId: owner, userId: member })
      await teams.addMember({ teamId: beta.teamId, tenantId: owner, userId: member })

      const page = await teams.listUserTeams({ userId: member, tenantId: owner, status: 'active' })
      expect(page.memberships.map(record => record.teamId)).toEqual([alpha.teamId, beta.teamId])
    })

    it('refuses to add a member under a different tenant than the team', async () => {
      const { teams } = await create()
      const home = tenantId('tenant-1')
      const other = tenantId('tenant-2')
      const team = await teams.create({ tenantId: home })

      await expect(teams.addMember({
        teamId: team.teamId,
        tenantId: other,
        userId: userId('user-1'),
      })).rejects.toMatchObject({ code: 'tenant-mismatch' })
      expect(await teams.getMembership(team.teamId, userId('user-1'))).toBeUndefined()
    })

    it('leaves active membership queries empty after revoke', async () => {
      const { teams } = await create()
      const owner = tenantId('tenant-1')
      const member = userId('user-1')
      const team = await teams.create({ tenantId: owner })
      const added = await teams.addMember({ teamId: team.teamId, tenantId: owner, userId: member })
      await teams.removeMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: added.revision,
      })

      expect((await teams.listMembers({ teamId: team.teamId, status: 'active' })).memberships).toEqual([])
      expect((await teams.listUserTeams({ userId: member, tenantId: owner, status: 'active' })).memberships)
        .toEqual([])
      await expect(teams.requireActiveMembership(team.teamId, member))
        .rejects.toMatchObject({ code: 'membership-removed' })
    })

    it('does not list another tenant\'s teams for the same user', async () => {
      const { teams } = await create()
      const home = tenantId('tenant-1')
      const other = tenantId('tenant-2')
      const member = userId('user-1')
      const homeTeam = await teams.create({ tenantId: home })
      await teams.create({ tenantId: other })
      await teams.addMember({ teamId: homeTeam.teamId, tenantId: home, userId: member })

      expect((await teams.listUserTeams({ userId: member, tenantId: other })).memberships).toEqual([])
      expect((await teams.listUserTeams({ userId: member, tenantId: home })).memberships)
        .toHaveLength(1)
    })

    it('rejects stale membership mutations atomically without emitting a commit event', async () => {
      const { ctx, teams } = await create()
      const owner = tenantId('tenant-1')
      const team = await teams.create({ tenantId: owner })
      const member = userId('user-1')
      const added = await teams.addMember({ teamId: team.teamId, tenantId: owner, userId: member })
      const events: TeamMembershipChangeEvent[] = []
      ctx.on('team/membership-changed', (event) => { events.push(event) })
      await teams.disableMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: added.revision,
      })

      await expect(teams.disableMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: added.revision,
      })).rejects.toMatchObject({ code: 'revision-conflict' })
      expect((await teams.getMembership(team.teamId, member))?.status).toBe('disabled')
      expect(events).toHaveLength(1)
    })

    it('enforces team and membership lifecycle states', async () => {
      const { teams } = await create()
      const owner = tenantId('tenant-1')
      const team = await teams.create({ tenantId: owner })
      expect(await teams.requireActive(team.teamId)).toEqual(team)
      const member = userId('user-1')
      const added = await teams.addMember({ teamId: team.teamId, tenantId: owner, userId: member })

      const disabledMember = await teams.disableMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: added.revision,
      })
      await expect(teams.requireActiveMembership(team.teamId, member))
        .rejects.toMatchObject({ code: 'membership-disabled' })
      await expect(teams.disableMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: disabledMember.revision,
      })).rejects.toMatchObject({ code: 'status-conflict' })

      const enabledMember = await teams.enableMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: disabledMember.revision,
      })
      const removed = await teams.removeMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: enabledMember.revision,
      })
      expect(removed).toMatchObject({ status: 'removed', revision: 4 })
      await expect(teams.requireActiveMembership(team.teamId, member))
        .rejects.toMatchObject({ code: 'membership-removed' })
      await expect(teams.enableMembership({
        teamId: team.teamId,
        userId: member,
        expectedRevision: removed.revision,
      })).rejects.toMatchObject({ code: 'membership-removed' })

      const disabledTeam = await teams.disable({
        teamId: team.teamId,
        expectedRevision: team.revision,
      })
      await expect(teams.requireActive(team.teamId)).rejects.toMatchObject({ code: 'team-disabled' })
      await expect(teams.addMember({ teamId: team.teamId, tenantId: owner, userId: userId('user-2') }))
        .rejects.toMatchObject({ code: 'team-disabled' })

      const enabledTeam = await teams.enable({
        teamId: team.teamId,
        expectedRevision: disabledTeam.revision,
      })
      const deleted = await teams.delete({
        teamId: team.teamId,
        expectedRevision: enabledTeam.revision,
      })
      expect(deleted).toMatchObject({ status: 'deleted', revision: 4 })
      await expect(teams.requireActive(team.teamId)).rejects.toMatchObject({ code: 'team-deleted' })
      await expect(teams.requireActiveMembership(team.teamId, member))
        .rejects.toMatchObject({ code: 'team-deleted' })
      await expect(teams.enable({ teamId: team.teamId, expectedRevision: deleted.revision }))
        .rejects.toMatchObject({ code: 'team-deleted' })
      await expect(teams.requireActive('missing' as never)).rejects.toMatchObject({ code: 'team-not-found' })
      await expect(teams.requireActiveMembership(enabledTeam.teamId, userId('missing')))
        .rejects.toMatchObject({ code: 'team-deleted' })
    })

    it('lists stable bounded membership pages and filters by status', async () => {
      const { teams } = await create()
      const owner = tenantId('tenant-1')
      const team = await teams.create({ tenantId: owner })
      const first = await teams.addMember({
        teamId: team.teamId,
        tenantId: owner,
        userId: userId('user-1'),
      })
      await teams.addMember({ teamId: team.teamId, tenantId: owner, userId: userId('user-2') })
      const third = await teams.addMember({
        teamId: team.teamId,
        tenantId: owner,
        userId: userId('user-3'),
      })
      await teams.disableMembership({
        teamId: team.teamId,
        userId: third.userId,
        expectedRevision: third.revision,
      })

      const pageOne = await teams.listMembers({ teamId: team.teamId, limit: 2 })
      const pageTwo = await teams.listMembers({
        teamId: team.teamId,
        limit: 2,
        cursor: pageOne.nextCursor!,
      })
      expect(pageOne.memberships.map(record => record.membershipId)).toEqual(['membership-1', 'membership-2'])
      expect(pageOne.nextCursor).toBe('2')
      expect(pageTwo.memberships.map(record => record.membershipId)).toEqual(['membership-3'])
      expect(pageTwo.nextCursor).toBeUndefined()
      expect((await teams.listMembers({ teamId: team.teamId, status: 'active' })).memberships)
        .toHaveLength(2)
      expect((await teams.listMembers({ teamId: team.teamId, status: 'disabled' }))
        .memberships.map(record => record.userId)).toEqual([third.userId])
      expect((await teams.listUserTeams({ userId: first.userId, tenantId: owner })).memberships)
        .toEqual([first])
      expect(first.status).toBe('active')
    })
  })
}
