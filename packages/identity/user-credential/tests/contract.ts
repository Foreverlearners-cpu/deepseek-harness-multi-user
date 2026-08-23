/** Shared user-credential Provider conformance suite. */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type UserCredentialService from '../src/index.ts'
import type { UserCredentialChangeEvent, UserId } from '../src/index.ts'

const id = (value: string): UserId => value as UserId

/** Fresh Provider service used for one conformance case. */
export interface UserCredentialContractHarness {
  readonly ctx: Context
  readonly credentials: UserCredentialService
}

/** Run shared identifier, password, concurrency, and redaction behavior. */
export function runUserCredentialContract(label: string, create: () => Promise<UserCredentialContractHarness>): void {
  describe(`user credential contract: ${label}`, () => {
    it('normalizes, adds, resolves, lists, and removes identifiers', async () => {
      const { credentials } = await create()
      const userId = id('user-1')
      expect(await credentials.normalize({ kind: 'email', value: ' Alice@Example.COM ' })).toEqual({ kind: 'email', value: 'alice@example.com' })
      const added = await credentials.addIdentifier({
        userId,
        expectedRevision: 0,
        kind: 'email',
        value: ' Alice@Example.COM ',
        context: {},
      })
      expect(added).toMatchObject({ userId, revision: 1, passwordEnabled: false })
      expect(added.identifiers).toEqual([{ kind: 'email', value: 'alice@example.com', createdAt: added.updatedAt }])
      expect(Object.isFrozen(added)).toBe(true)
      expect(Object.isFrozen(added.identifiers)).toBe(true)
      expect(await credentials.resolve({ kind: 'email', value: 'ALICE@example.com' })).toBe(userId)
      expect(await credentials.resolve({ kind: 'email', value: 'missing@example.com' })).toBeUndefined()
      expect(await credentials.list(userId)).toEqual(added)
      expect(await credentials.get(id('missing'))).toBeUndefined()

      const removed = await credentials.removeIdentifier({ userId, expectedRevision: 1, kind: 'email', value: 'alice@example.com' })
      expect(removed.identifiers).toEqual([])
      expect(removed.revision).toBe(2)
      expect(await credentials.resolve({ kind: 'email', value: 'alice@example.com' })).toBeUndefined()
      await expect(credentials.removeIdentifier({ userId, expectedRevision: 2, kind: 'email', value: 'alice@example.com' })).rejects.toMatchObject({ code: 'identifier-not-found' })
    })

    it('enforces global normalized identifier uniqueness', async () => {
      const { credentials } = await create()
      await credentials.addIdentifier({ userId: id('user-1'), expectedRevision: 0, kind: 'username', value: 'Alice' })
      await expect(credentials.addIdentifier({ userId: id('user-2'), expectedRevision: 0, kind: 'username', value: ' alice ' })).rejects.toMatchObject({ code: 'identifier-conflict' })
    })

    it('sets, verifies, changes, and disables passwords without returning secrets', async () => {
      const { credentials } = await create()
      const userId = id('user-1')
      const set = await credentials.setPassword({ userId, expectedRevision: 0, password: 'secret-one' })
      expect(set).toMatchObject({ revision: 1, passwordEnabled: true, passwordChangedAt: set.updatedAt })
      expect(JSON.stringify(set)).not.toContain('secret-one')
      expect(await credentials.verifyPassword({ userId, password: 'secret-one' })).toBe(true)
      expect(await credentials.verifyPassword({ userId, password: 'wrong' })).toBe(false)
      await expect(credentials.changePassword({ userId, expectedRevision: 1, currentPassword: 'wrong', newPassword: 'secret-two' })).rejects.toMatchObject({ code: 'invalid-credential' })
      const changed = await credentials.changePassword({ userId, expectedRevision: 1, currentPassword: 'secret-one', newPassword: 'secret-two' })
      expect(await credentials.verifyPassword({ userId, password: 'secret-one' })).toBe(false)
      expect(await credentials.verifyPassword({ userId, password: 'secret-two' })).toBe(true)
      const disabled = await credentials.disablePassword({ userId, expectedRevision: changed.revision })
      expect(disabled).toMatchObject({ passwordEnabled: false, revision: 3 })
      expect(disabled.passwordChangedAt).toBeUndefined()
      expect(await credentials.verifyPassword({ userId, password: 'secret-two' })).toBe(false)
      await expect(credentials.disablePassword({ userId, expectedRevision: disabled.revision })).rejects.toMatchObject({ code: 'password-not-set' })
    })

    it('uses the same false result and verification path for absent and incorrect credentials', async () => {
      const { credentials } = await create()
      const memory = credentials as UserCredentialService & { verificationWork: number }
      await credentials.setPassword({ userId: id('user-1'), expectedRevision: 0, password: 'secret' })
      expect(await credentials.verifyPassword({ userId: id('user-1'), password: 'wrong' })).toBe(false)
      expect(await credentials.verifyPassword({ userId: id('missing'), password: 'wrong' })).toBe(false)
      expect(memory.verificationWork).toBe(2)
    })

    it('rejects stale mutations atomically and emits only sanitized post-commit events', async () => {
      const { ctx, credentials } = await create()
      const events: UserCredentialChangeEvent[] = []
      ctx.on('user-credential/changed', (event) => { events.push(event) })
      const userId = id('user-1')
      const actorUserId = id('admin-1')
      await credentials.addIdentifier({
        userId,
        expectedRevision: 0,
        kind: 'username',
        value: 'SensitiveLogin',
        context: { actorUserId, correlationId: 'request-1', reason: ' provision login ' },
      })
      await expect(credentials.setPassword({ userId, expectedRevision: 0, password: 'never-committed' })).rejects.toMatchObject({ code: 'revision-conflict' })
      expect(events).toEqual([{
        kind: 'identifier-added', userId, revision: 1, time: events[0]!.time,
        actorUserId, correlationId: 'request-1', reason: 'provision login',
      }])
      expect(JSON.stringify(events)).not.toContain('SensitiveLogin')
      expect(JSON.stringify(events)).not.toContain('never-committed')
    })
  })
}
