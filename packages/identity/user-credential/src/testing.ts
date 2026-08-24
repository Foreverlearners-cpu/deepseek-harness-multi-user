/** Framework-neutral Provider contract suite for `@deepseek-ai/dsh-user-credential`. */

import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { UserCredentialError } from './index.ts'
import type UserCredentialService from './index.ts'
import type { UserCredentialChangeEvent, UserId } from './types.ts'

const userId = (value: string): UserId => value as UserId

/** Fresh live Provider and an explicit dummy-verification work probe. */
export interface UserCredentialContractHarness {
  readonly ctx: Context
  readonly credentials: UserCredentialService
  /** @returns number of password verification attempts performed by the Provider. */
  readonly readPasswordVerificationCount: () => number
}

/** Test-framework registration functions used by the reusable suite. */
export interface UserCredentialContractRegistrar {
  /** @param label - suite label; @param define - synchronous case registration. */
  readonly suite: (label: string, define: () => void) => void
  /** @param label - case label; @param run - asynchronous contract case. */
  readonly test: (label: string, run: () => Promise<void>) => void
}

/**
 * Register the normative identifier, password, concurrency, and redaction suite.
 * @param registrar - adapter for the Consumer's test framework.
 * @param label - Provider label included in the suite name.
 * @param create - fresh empty live Provider harness for each case.
 */
export function runUserCredentialContract(
  registrar: UserCredentialContractRegistrar,
  label: string,
  create: () => Promise<UserCredentialContractHarness>,
): void {
  registrar.suite(`user credential contract: ${label}`, () => {
    registrar.test('normalizes, adds, resolves, lists, and removes identifiers', async () => {
      const { credentials } = await create()
      const target = userId('user-1')
      assert.deepEqual(await credentials.normalize({ kind: 'email', value: ' Alice@Example.COM ' }), {
        kind: 'email',
        value: 'alice@example.com',
      })
      const added = await credentials.addIdentifier({
        userId: target,
        expectedRevision: 0,
        kind: 'email',
        value: ' Alice@Example.COM ',
        context: {},
      })
      assert.equal(added.revision, 1)
      assert.equal(added.passwordEnabled, false)
      assert.deepEqual(added.identifiers, [{ kind: 'email', value: 'alice@example.com', createdAt: added.updatedAt }])
      assert.equal(Object.isFrozen(added), true)
      assert.equal(Object.isFrozen(added.identifiers), true)
      assert.equal(await credentials.resolve({ kind: 'email', value: 'ALICE@example.com' }), target)
      assert.equal(await credentials.resolve({ kind: 'email', value: 'missing@example.com' }), undefined)
      assert.deepEqual(await credentials.list(target), added)
      assert.equal(await credentials.get(userId('missing')), undefined)

      const removed = await credentials.removeIdentifier({
        userId: target,
        expectedRevision: 1,
        kind: 'email',
        value: 'alice@example.com',
      })
      assert.deepEqual(removed.identifiers, [])
      assert.equal(removed.revision, 2)
      assert.equal(await credentials.resolve({ kind: 'email', value: 'alice@example.com' }), undefined)
      await assert.rejects(
        credentials.removeIdentifier({
          userId: target,
          expectedRevision: 2,
          kind: 'email',
          value: 'alice@example.com',
        }),
        { code: 'identifier-not-found' },
      )
    })

    registrar.test('enforces global normalized identifier uniqueness', async () => {
      const { credentials } = await create()
      await credentials.addIdentifier({
        userId: userId('user-1'), expectedRevision: 0, kind: 'username', value: 'Alice',
      })
      await assert.rejects(
        credentials.addIdentifier({
          userId: userId('user-2'), expectedRevision: 0, kind: 'username', value: ' alice ',
        }),
        { code: 'identifier-conflict' },
      )
    })

    registrar.test('sets, verifies, changes, and disables passwords without returning secrets', async () => {
      const { credentials } = await create()
      const target = userId('user-1')
      const set = await credentials.setPassword({ userId: target, expectedRevision: 0, password: 'secret-one' })
      assert.equal(set.revision, 1)
      assert.equal(set.passwordEnabled, true)
      assert.equal(set.passwordChangedAt, set.updatedAt)
      assert.equal(JSON.stringify(set).includes('secret-one'), false)
      assert.equal(await credentials.verifyPassword({ userId: target, password: 'secret-one' }), true)
      assert.equal(await credentials.verifyPassword({ userId: target, password: 'wrong' }), false)
      await assert.rejects(
        credentials.changePassword({
          userId: target, expectedRevision: 1, currentPassword: 'wrong', newPassword: 'secret-two',
        }),
        { code: 'invalid-credential' },
      )
      const changed = await credentials.changePassword({
        userId: target, expectedRevision: 1, currentPassword: 'secret-one', newPassword: 'secret-two',
      })
      assert.equal(await credentials.verifyPassword({ userId: target, password: 'secret-one' }), false)
      assert.equal(await credentials.verifyPassword({ userId: target, password: 'secret-two' }), true)
      const disabled = await credentials.disablePassword({ userId: target, expectedRevision: changed.revision })
      assert.equal(disabled.passwordEnabled, false)
      assert.equal(disabled.revision, 3)
      assert.equal(disabled.passwordChangedAt, undefined)
      assert.equal(await credentials.verifyPassword({ userId: target, password: 'secret-two' }), false)
      await assert.rejects(
        credentials.disablePassword({ userId: target, expectedRevision: disabled.revision }),
        { code: 'password-not-set' },
      )
    })

    registrar.test('uses the same false result and verification path for absent and incorrect credentials', async () => {
      const harness = await create()
      const target = userId('user-1')
      await harness.credentials.setPassword({ userId: target, expectedRevision: 0, password: 'secret' })
      const before = harness.readPasswordVerificationCount()
      assert.equal(await harness.credentials.verifyPassword({ userId: target, password: 'wrong' }), false)
      assert.equal(await harness.credentials.verifyPassword({ password: 'wrong' }), false)
      assert.equal(harness.readPasswordVerificationCount() - before, 2)
    })

    registrar.test('allows exactly one of two concurrent mutations from the same revision', async () => {
      const { credentials } = await create()
      const target = userId('user-1')
      const initial = await credentials.addIdentifier({
        userId: target, expectedRevision: 0, kind: 'username', value: 'alice',
      })
      const outcomes = await Promise.allSettled([
        credentials.addIdentifier({
          userId: target, expectedRevision: initial.revision, kind: 'email', value: 'alice@example.com',
        }),
        credentials.setPassword({ userId: target, expectedRevision: initial.revision, password: 'secret' }),
      ])
      const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled')
      const rejected = outcomes.filter(outcome => outcome.status === 'rejected')
      assert.equal(fulfilled.length, 1)
      assert.equal(rejected.length, 1)
      const rejection = rejected[0]
      assert.ok(rejection)
      assert.equal(rejection.status, 'rejected')
      assert.ok(rejection.reason instanceof UserCredentialError)
      assert.equal(rejection.reason.code, 'revision-conflict')
      assert.equal((await credentials.get(target))?.revision, initial.revision + 1)
    })

    registrar.test('rejects stale mutations and emits only sanitized post-commit events', async () => {
      const { ctx, credentials } = await create()
      const events: UserCredentialChangeEvent[] = []
      ctx.on('user-credential/changed', (event) => { events.push(event) })
      const target = userId('user-1')
      const actor = userId('admin-1')
      await credentials.addIdentifier({
        userId: target,
        expectedRevision: 0,
        kind: 'username',
        value: 'SensitiveLogin',
        context: { actorUserId: actor, correlationId: 'request-1', reason: ' provision login ' },
      })
      await assert.rejects(
        credentials.setPassword({ userId: target, expectedRevision: 0, password: 'never-committed' }),
        { code: 'revision-conflict' },
      )
      const event = events[0]
      assert.ok(event)
      assert.deepEqual(events, [{
        kind: 'identifier-added',
        userId: target,
        revision: 1,
        time: event.time,
        actorUserId: actor,
        correlationId: 'request-1',
        reason: 'provision login',
      }])
      assert.equal(JSON.stringify(events).includes('SensitiveLogin'), false)
      assert.equal(JSON.stringify(events).includes('never-committed'), false)
    })
  })
}
