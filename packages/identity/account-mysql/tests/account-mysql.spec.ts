import { describe, expect, it, vi } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Context } from '@deepseek-ai/cordis'
import {
  type AccountRecoveryState,
  type RegistrationOperationAdvanceRequest,
} from '@deepseek-ai/dsh-account'
import { authenticationRequestId } from '@deepseek-ai/dsh-auth'
import { userId, type UserRecord } from '@deepseek-ai/dsh-user'
import * as accountMysql from '../src/index.ts'
import {
  ACCOUNT_MYSQL_SCHEMA_VERSION,
  AccountMysqlRegistrationOperations,
  inject,
  name,
} from '../src/index.ts'
import { initializeSchema } from '../src/schema.ts'
import { FakeMysql, type FakeOperationRow } from './fake-mysql.ts'

const requestId = authenticationRequestId('registration-1')
const firstUserId = userId('user-1')
const recovery: AccountRecoveryState = {
  userId: firstUserId,
  operation: 'registration',
  userStatus: 'disabled',
  credentialsConfigured: false,
  compensationComplete: true,
}
const completedUser: UserRecord = {
  userId: firstUserId,
  displayName: 'Alice',
  status: 'active',
  createdAt: 1_000,
  updatedAt: 1_001,
  revision: 1,
  extensions: { 'example/locale': 'zh-CN' },
}

function setup(mysql = new FakeMysql()): {
  mysql: FakeMysql
  provider: AccountMysqlRegistrationOperations
} {
  return { mysql, provider: new AccountMysqlRegistrationOperations(mysql.asService()) }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function advance(
  provider: AccountMysqlRegistrationOperations,
  expectedRevision: number,
  expectedStage: RegistrationOperationAdvanceRequest['expectedStage'],
  stage: RegistrationOperationAdvanceRequest['stage'],
  recoveryState?: AccountRecoveryState,
): Promise<void> {
  await provider.advance({
    requestId,
    expectedRevision,
    expectedStage,
    stage,
    userId: firstUserId,
    ...(recoveryState === undefined ? {} : { recovery: recoveryState }),
  })
}

describe('AccountMysqlRegistrationOperations', () => {
  it('begins idempotently, reads missing keys, and completes the exact staged operation', async () => {
    const { mysql, provider } = setup()
    await expect(provider.read(requestId)).resolves.toBeUndefined()
    const first = await provider.begin(requestId)
    const retry = await provider.begin(requestId)
    expect(first).toEqual({ requestId, revision: 1, stage: 'begun' })
    expect(retry).toEqual(first)
    expect(mysql.rows).toHaveLength(1)

    await advance(provider, 1, 'begun', 'user-created')
    await advance(provider, 2, 'user-created', 'identifier-added')
    await advance(provider, 3, 'identifier-added', 'password-set')
    const completed = await provider.complete(requestId, 4, completedUser)
    expect(completed).toEqual({
      requestId,
      revision: 5,
      stage: 'completed',
      userId: firstUserId,
      result: completedUser,
    })
    await expect(provider.begin(requestId)).resolves.toEqual(completed)
    await expect(provider.complete(requestId, 5, { ...completedUser, displayName: 'Changed' }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(provider.advance({
      requestId, expectedRevision: 5, expectedStage: 'completed', stage: 'failed',
      userId: firstUserId, recovery,
    })).rejects.toMatchObject({ code: 'conflict' })
    await expect(provider.read(requestId)).resolves.toEqual(completed)
  })

  it('persists a complete non-secret failed-operation recovery state', async () => {
    const { mysql, provider } = setup()
    await provider.begin(requestId)
    const failed = await provider.advance({
      requestId,
      expectedRevision: 1,
      expectedStage: 'begun',
      stage: 'failed',
      userId: firstUserId,
      recovery,
    })
    expect(failed).toEqual({
      requestId,
      revision: 2,
      stage: 'failed',
      userId: firstUserId,
      recovery,
    })
    expect(JSON.stringify(mysql.rows.get(requestId))).not.toContain('password')
  })

  it('rejects stale, invalid, and cross-user transitions without mutation', async () => {
    const { provider } = setup()
    await expect(provider.advance({
      requestId, expectedRevision: 1, expectedStage: 'begun', stage: 'user-created', userId: firstUserId,
    })).rejects.toMatchObject({ code: 'conflict' })
    await provider.begin(requestId)
    await expect(provider.advance({
      requestId, expectedRevision: 2, expectedStage: 'begun', stage: 'user-created', userId: firstUserId,
    })).rejects.toMatchObject({ code: 'conflict' })
    await expect(provider.advance({
      requestId, expectedRevision: 1, expectedStage: 'begun', stage: 'password-set', userId: firstUserId,
    })).rejects.toMatchObject({ code: 'conflict' })
    await expect(provider.advance({
      requestId, expectedRevision: 1, expectedStage: 'begun', stage: 'user-created',
      userId: firstUserId, recovery,
    })).rejects.toMatchObject({ code: 'conflict' })
    await expect(provider.advance({
      requestId, expectedRevision: 1, expectedStage: 'begun', stage: 'failed', userId: firstUserId,
    })).rejects.toMatchObject({ code: 'conflict' })
    await expect(provider.advance({
      requestId, expectedRevision: 1, expectedStage: 'begun', stage: 'failed', userId: firstUserId,
      recovery: { ...recovery, userId: userId('other') },
    })).rejects.toMatchObject({ code: 'conflict' })

    await advance(provider, 1, 'begun', 'user-created')
    await expect(provider.advance({
      requestId, expectedRevision: 2, expectedStage: 'user-created', stage: 'identifier-added', userId: userId('other'),
    })).rejects.toMatchObject({ code: 'conflict' })
    await expect(provider.complete(requestId, 2, completedUser)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rolls back impossible updates and maps driver and rollback diagnostics safely', async () => {
    const { mysql, provider } = setup()
    await provider.begin(requestId)
    mysql.zeroNextUpdate = true
    await expect(advance(provider, 1, 'begun', 'user-created')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(provider.read(requestId)).resolves.toMatchObject({ revision: 1, stage: 'begun' })

    mysql.failNext = new Error('SELECT password=secret')
    const error = await provider.read(requestId).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'unavailable', message: 'account-mysql: storage operation failed' })
    expect(JSON.stringify(error)).not.toContain('password=secret')

    mysql.rejectNextConnection = new Error('pool password=secret')
    await expect(provider.read(requestId)).rejects.toMatchObject({ code: 'unavailable' })

    mysql.failNext = new Error('insert password=secret')
    await expect(provider.begin(authenticationRequestId('registration-2')))
      .rejects.toMatchObject({ code: 'unavailable', message: 'account-mysql: storage operation failed' })

    mysql.failNext = new Error('insert failed')
    mysql.rollbackFailure = new Error('rollback password=secret')
    await expect(provider.begin(authenticationRequestId('registration-3')))
      .rejects.toMatchObject({ code: 'unavailable', message: 'account-mysql: transaction rollback failed' })
  })

  it('rejects disappeared locked rows and failed completion updates atomically', async () => {
    const begunHarness = setup()
    begunHarness.mysql.hideNextLockedRead = true
    await expect(begunHarness.provider.begin(requestId)).rejects.toMatchObject({ code: 'unavailable' })

    const updateHarness = setup()
    await updateHarness.provider.begin(requestId)
    updateHarness.mysql.hideNextLockedRead = true
    await expect(advance(updateHarness.provider, 1, 'begun', 'user-created'))
      .rejects.toMatchObject({ code: 'conflict' })

    const completionHarness = setup()
    await expect(completionHarness.provider.complete(requestId, 1, completedUser))
      .rejects.toMatchObject({ code: 'conflict' })
    await completionHarness.provider.begin(requestId)
    await advance(completionHarness.provider, 1, 'begun', 'user-created')
    await advance(completionHarness.provider, 2, 'user-created', 'identifier-added')
    await advance(completionHarness.provider, 3, 'identifier-added', 'password-set')
    completionHarness.mysql.zeroNextUpdate = true
    await expect(completionHarness.provider.complete(requestId, 4, completedUser))
      .rejects.toMatchObject({ code: 'unavailable' })
    await expect(completionHarness.provider.read(requestId)).resolves.toMatchObject({ stage: 'password-set' })
    await expect(completionHarness.provider.complete(requestId, 4, { ...completedUser, userId: userId('other') }))
      .rejects.toMatchObject({ code: 'conflict' })

    const hiddenAdvance = setup()
    await hiddenAdvance.provider.begin(requestId)
    hiddenAdvance.mysql.hideLockedReadCountdown = 2
    await expect(advance(hiddenAdvance.provider, 1, 'begun', 'user-created'))
      .rejects.toMatchObject({ code: 'unavailable' })

    const hiddenComplete = setup()
    await hiddenComplete.provider.begin(requestId)
    await advance(hiddenComplete.provider, 1, 'begun', 'user-created')
    await advance(hiddenComplete.provider, 2, 'user-created', 'identifier-added')
    await advance(hiddenComplete.provider, 3, 'identifier-added', 'password-set')
    hiddenComplete.mysql.hideLockedReadCountdown = 2
    await expect(hiddenComplete.provider.complete(requestId, 4, {
      userId: completedUser.userId,
      status: completedUser.status,
      createdAt: completedUser.createdAt,
      updatedAt: completedUser.updatedAt,
      revision: completedUser.revision,
      extensions: completedUser.extensions,
    }))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects malformed durable rows through one redacted category', async () => {
    const mutations: Array<(row: FakeOperationRow) => void> = [
      (row) => { row.request_id = '' },
      (row) => { row.request_id = 'other-request' },
      (row) => { row.revision = 0 },
      (row) => { row.stage = 'unknown' },
      (row) => { row.user_id = 'unexpected' },
      (row) => { row.stage = 'user-created'; row.revision = 2 },
      (row) => { row.stage = 'failed'; row.revision = 6; row.user_id = firstUserId; row.recovery_operation = 'registration'; row.recovery_user_id = firstUserId; row.recovery_user_status = 'disabled'; row.recovery_credentials_configured = 0; row.recovery_compensation_complete = 1 },
      (row) => { row.stage = 'user-created'; row.revision = 2; row.user_id = firstUserId; row.result_user_id = firstUserId; row.result_status = 'active'; row.result_created_at = 1; row.result_updated_at = 1; row.result_revision = 1; row.result_extensions = {} },
      (row) => { row.recovery_operation = 'registration' },
      (row) => { row.result_display_name = 'unexpected' },
    ]
    for (const mutate of mutations) {
      const { mysql, provider } = setup()
      await provider.begin(requestId)
      mutate(mysql.rows.get(requestId)!)
      await expect(provider.read(requestId)).rejects.toMatchObject({ code: 'unavailable' })
    }

    const failedMutations: Array<(row: FakeOperationRow) => void> = [
      (row) => { row.recovery_operation = 'unknown' },
      (row) => { row.recovery_user_id = '' },
      (row) => { row.recovery_user_status = 'unknown' },
      (row) => { row.recovery_credentials_configured = 2 },
      (row) => { row.recovery_compensation_complete = 'bad' },
      (row) => { row.recovery_user_id = 'other' },
      (row) => { row.result_user_id = 'unexpected'; row.result_status = 'active'; row.result_created_at = 1; row.result_updated_at = 1; row.result_revision = 1; row.result_extensions = {} },
    ]
    for (const mutate of failedMutations) {
      const { mysql, provider } = setup()
      await provider.begin(requestId)
      await advance(provider, 1, 'begun', 'failed', recovery)
      mutate(mysql.rows.get(requestId)!)
      await expect(provider.read(requestId)).rejects.toMatchObject({ code: 'unavailable' })
    }

    const unexpectedRecovery = setup()
    await unexpectedRecovery.provider.begin(requestId)
    await advance(unexpectedRecovery.provider, 1, 'begun', 'user-created')
    Object.assign(unexpectedRecovery.mysql.rows.get(requestId)!, {
      recovery_operation: 'registration',
      recovery_user_id: firstUserId,
      recovery_user_status: 'disabled',
      recovery_credentials_configured: 0,
      recovery_compensation_complete: 1,
    })
    await expect(unexpectedRecovery.provider.read(requestId)).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects malformed completed results and accepts BIGINT strings and JSON text', async () => {
    const mutations: Array<(row: FakeOperationRow) => void> = [
      (row) => { row.result_user_id = null },
      (row) => { row.result_user_id = '' },
      (row) => { row.result_status = 'unknown' },
      (row) => { row.result_created_at = -1 },
      (row) => { row.result_updated_at = 999 },
      (row) => { row.result_revision = 0 },
      (row) => { row.result_display_name = '' },
      (row) => { row.result_display_name = ' Alice ' },
      (row) => { row.result_extensions = 'invalid json' },
      (row) => { row.result_extensions = { unnamespaced: true } },
      (row) => { row.user_id = 'other' },
      (row) => { row.stage = 'password-set' },
    ]
    for (const mutate of mutations) {
      const { mysql, provider } = setup()
      await provider.begin(requestId)
      await advance(provider, 1, 'begun', 'user-created')
      await advance(provider, 2, 'user-created', 'identifier-added')
      await advance(provider, 3, 'identifier-added', 'password-set')
      await provider.complete(requestId, 4, completedUser)
      mutate(mysql.rows.get(requestId)!)
      await expect(provider.read(requestId)).rejects.toMatchObject({ code: 'unavailable' })
    }

    const { mysql, provider } = setup()
    await provider.begin(requestId)
    await advance(provider, 1, 'begun', 'failed', recovery)
    const row = mysql.rows.get(requestId)!
    row.revision = '2'
    row.recovery_credentials_configured = '0'
    row.recovery_compensation_complete = '1'
    await expect(provider.read(requestId)).resolves.toEqual({
      requestId, revision: 2, stage: 'failed', userId: firstUserId, recovery,
    })
  })
})

describe('account-mysql plugin and schema', () => {
  it('initializes, verifies, and claims the Provider-owned table', async () => {
    const mysql = new FakeMysql()
    await mysql.connection(initializeSchema)
    expect(ACCOUNT_MYSQL_SCHEMA_VERSION).toBe(1)
    expect(mysql).toMatchObject({ schemaVersion: 1, operationTableExists: true })
    expect(mysql.queries).toContainEqual(expect.stringContaining('request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin'))
    await expect(mysql.connection(initializeSchema)).resolves.toBeUndefined()
  })

  it('serializes concurrent schema initialization and creates the owned table once', async () => {
    const mysql = new FakeMysql()
    const entered = deferred()
    const release = deferred()
    let first = true
    mysql.afterSchemaLock = async () => {
      if (!first) return
      first = false
      entered.resolve()
      await release.promise
    }
    const firstInitialization = mysql.connection(initializeSchema)
    await entered.promise
    let secondSettled = false
    const secondInitialization = mysql.connection(initializeSchema).finally(() => { secondSettled = true })
    await Promise.resolve()
    expect(secondSettled).toBe(false)
    release.resolve()
    await expect(Promise.all([firstInitialization, secondInitialization])).resolves.toEqual([undefined, undefined])
    expect(mysql.queries.filter(query => query.startsWith('CREATE TABLE dsh_account_registration_operations')))
      .toHaveLength(1)
    expect(mysql.queries.filter(query => query.startsWith('SELECT RELEASE_LOCK('))).toHaveLength(2)
  })

  it('rejects unsafe schema states and lock failures', async () => {
    for (const mutate of [
      (mysql: FakeMysql) => { mysql.schemaLockResult = 0 },
      (mysql: FakeMysql) => { mysql.schemaUnlockResult = null },
      (mysql: FakeMysql) => { mysql.schemaVersion = 2 },
      (mysql: FakeMysql) => { mysql.operationTableExists = true },
      (mysql: FakeMysql) => { mysql.schemaVersion = 1 },
    ]) {
      const mysql = new FakeMysql()
      mutate(mysql)
      await expect(mysql.connection(initializeSchema)).rejects.toBeDefined()
    }
    const combined = new FakeMysql()
    combined.schemaVersion = 2
    combined.schemaUnlockResult = 0
    await expect(combined.connection(initializeSchema)).rejects.toBeInstanceOf(AggregateError)
  })

  it('retains namespace injections through the real Loader and starts after both services', async () => {
    const mysql = new FakeMysql()
    const disposer = vi.fn()
    const register = vi.fn(() => disposer)
    expect('default' in accountMysql).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(accountMysql) as typeof accountMysql
    expect(unwrapped).toBe(accountMysql)
    expect(name).toBe('account-mysql')
    expect(inject).toEqual(['accounts', 'mysql'])
    const ctx = new Context()
    ctx.provide('mysql', mysql.asService())
    ctx.provide('accounts', { registrationOperations: { register } } as never)
    await ctx.plugin(unwrapped)
    expect(register).toHaveBeenCalledWith(expect.any(AccountMysqlRegistrationOperations))
    await ctx.fiber.dispose()
    expect(disposer).toHaveBeenCalledOnce()

    const failed = new FakeMysql()
    failed.failNext = new Error('CREATE password=secret')
    const error = await accountMysql.apply({ mysql: failed.asService() } as never).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'unavailable', message: 'account-mysql: schema initialization failed' })
    expect(JSON.stringify(error)).not.toContain('password=secret')
  })
})
