/** Shared user-directory Provider conformance suite. */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type UserDirectory from '../src/index.ts'
import { userId, type UserChangeEvent } from '../src/index.ts'

/** Fresh Provider service used for one conformance case. */
export interface UserDirectoryContractHarness {
  readonly ctx: Context
  readonly users: UserDirectory
}

/**
 * Run the shared lifecycle and consistency contract against one Provider.
 * @param label - Provider label used in the test suite name.
 * @param create - factory returning an empty live Provider per test.
 */
export function runUserDirectoryContract(
  label: string,
  create: () => Promise<UserDirectoryContractHarness>,
): void {
  describe(`user directory contract: ${label}`, () => {
    it('creates stable ids and returns immutable detached records', async () => {
      const { users } = await create()
      const source = { nested: { locale: 'zh-CN' } }
      const first = await users.create({
        displayName: '  Alice  ',
        extensions: { 'example/profile': source },
      })
      source.nested.locale = 'changed'
      const second = await users.create()

      expect(first).toEqual({
        userId: 'user-1',
        displayName: 'Alice',
        status: 'active',
        createdAt: first.createdAt,
        updatedAt: first.updatedAt,
        revision: 1,
        extensions: { 'example/profile': { nested: { locale: 'zh-CN' } } },
      })
      expect(second.userId).toBe('user-2')
      expect(Number.isSafeInteger(first.createdAt)).toBe(true)
      expect(Number.isSafeInteger(first.updatedAt)).toBe(true)
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(first.extensions)).toBe(true)
      expect(Object.isFrozen(first.extensions['example/profile'])).toBe(true)
      expect(await users.get(first.userId)).toEqual(first)
      expect(await users.get(userId('missing'))).toBeUndefined()
    })

    it('updates only profile fields and carries trusted operation metadata on a sanitized event', async () => {
      const { ctx, users } = await create()
      const events: UserChangeEvent[] = []
      ctx.on('user/changed', (event) => { events.push(event) })
      const actorUserId = userId('admin-1')
      const created = await users.create({ displayName: 'Before', extensions: { 'example/value': 1 } })
      const updated = await users.update({
        userId: created.userId,
        expectedRevision: created.revision,
        patch: { displayName: 'After', extensions: { 'example/value': 2 } },
        context: { actorUserId, correlationId: 'request-1', reason: 'profile correction' },
      })

      expect(updated).toMatchObject({
        displayName: 'After',
        status: 'active',
        revision: 2,
        extensions: { 'example/value': 2 },
      })
      expect(events.at(-1)).toEqual({
        kind: 'profile-updated',
        userId: created.userId,
        revision: 2,
        status: 'active',
        time: updated.updatedAt,
        actorUserId,
        correlationId: 'request-1',
        reason: 'profile correction',
      })
      expect(JSON.stringify(events)).not.toContain('After')
      expect(JSON.stringify(events)).not.toContain('example/value')

      const cleared = await users.update({
        userId: created.userId,
        expectedRevision: updated.revision,
        patch: { displayName: null },
      })
      expect(cleared.displayName).toBeUndefined()
      expect(cleared.extensions).toEqual({ 'example/value': 2 })

      const extensionsOnly = await users.update({
        userId: created.userId,
        expectedRevision: cleared.revision,
        patch: { extensions: { 'example/value': 3 } },
        context: {},
      })
      expect(extensionsOnly.displayName).toBeUndefined()
      expect(extensionsOnly.extensions).toEqual({ 'example/value': 3 })
    })

    it('rejects stale updates atomically without emitting a commit event', async () => {
      const { ctx, users } = await create()
      const created = await users.create({ displayName: 'Original' })
      const events: UserChangeEvent[] = []
      ctx.on('user/changed', (event) => { events.push(event) })
      await users.update({
        userId: created.userId,
        expectedRevision: created.revision,
        patch: { displayName: 'Committed' },
      })

      await expect(users.update({
        userId: created.userId,
        expectedRevision: created.revision,
        patch: { displayName: 'Stale' },
      })).rejects.toMatchObject({ code: 'revision-conflict' })
      expect((await users.get(created.userId))?.displayName).toBe('Committed')
      expect(events).toHaveLength(1)
    })

    it('enforces active, disabled, and terminal deleted lifecycle states', async () => {
      const { users } = await create()
      const created = await users.create()
      expect(await users.requireActive(created.userId)).toEqual(created)

      const disabled = await users.disable({ userId: created.userId, expectedRevision: 1 })
      await expect(users.requireActive(created.userId)).rejects.toMatchObject({ code: 'user-disabled' })
      await expect(users.disable({ userId: created.userId, expectedRevision: 2 })).rejects.toMatchObject({
        code: 'status-conflict',
      })

      const enabled = await users.enable({ userId: created.userId, expectedRevision: disabled.revision })
      expect(enabled.status).toBe('active')
      const deleted = await users.delete({ userId: created.userId, expectedRevision: enabled.revision })
      expect(deleted).toMatchObject({ status: 'deleted', revision: 4 })
      await expect(users.requireActive(created.userId)).rejects.toMatchObject({ code: 'user-deleted' })
      await expect(users.enable({ userId: created.userId, expectedRevision: deleted.revision })).rejects.toMatchObject({
        code: 'user-deleted',
      })
      await expect(users.update({
        userId: created.userId,
        expectedRevision: deleted.revision,
        patch: { displayName: 'Never' },
      })).rejects.toMatchObject({ code: 'user-deleted' })
      await expect(users.requireActive(userId('missing'))).rejects.toMatchObject({ code: 'user-not-found' })
    })

    it('lists stable bounded pages and filters by lifecycle status', async () => {
      const { users } = await create()
      const first = await users.create({ displayName: 'One' })
      await users.create({ displayName: 'Two' })
      const third = await users.create({ displayName: 'Three' })
      await users.disable({ userId: third.userId, expectedRevision: third.revision })

      const pageOne = await users.list({ limit: 2 })
      const pageTwo = await users.list({ limit: 2, cursor: pageOne.nextCursor! })
      expect(pageOne.users.map(user => user.userId)).toEqual(['user-1', 'user-2'])
      expect(pageOne.nextCursor).toBe('2')
      expect(pageTwo.users.map(user => user.userId)).toEqual(['user-3'])
      expect(pageTwo.nextCursor).toBeUndefined()
      expect((await users.list({ status: 'active' })).users).toHaveLength(2)
      expect((await users.list({ status: 'disabled' })).users.map(user => user.userId)).toEqual([third.userId])
      expect(first.status).toBe('active')
    })
  })
}
