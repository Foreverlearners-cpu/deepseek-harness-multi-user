import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authenticationRequestId } from '@deepseek-ai/dsh-auth'
import Mysql, { type Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'
import { Context } from '@deepseek-ai/cordis'
import { RegistrationOperationProviderRegistry } from '@deepseek-ai/dsh-account'
import { userId, type UserRecord } from '@deepseek-ai/dsh-user'
import * as accountMysql from '../src/index.ts'

const target = process.env.DSH_MYSQL_TEST_URL
const requestId = authenticationRequestId('account-mysql-e2e')
const targetUserId = userId('account-mysql-e2e-user')
const result: UserRecord = {
  userId: targetUserId,
  status: 'active',
  createdAt: 1_000,
  updatedAt: 1_000,
  revision: 1,
  extensions: { 'example/source': 'mysql-e2e' },
}
let ctx: Context | undefined

function config(): MysqlConfig {
  const url = new URL(target!)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (url.protocol !== 'mysql:' || database.length === 0) throw new Error('DSH_MYSQL_TEST_URL must name a mysql database')
  return {
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 4,
  }
}

async function dropOwnedTables(context: Context): Promise<void> {
  await context.mysql.connection(async (connection) => {
    await connection.query('DROP TABLE IF EXISTS dsh_account_registration_operations')
    await connection.query('DROP TABLE IF EXISTS dsh_account_schema')
  })
}

beforeEach(async () => {
  if (target === undefined) return
  ctx = new Context()
  await ctx.plugin(Mysql, config())
  await dropOwnedTables(ctx)
  ctx.provide('accounts', {
    registrationOperations: new RegistrationOperationProviderRegistry(),
  } as never)
  await ctx.plugin(accountMysql)
})

afterEach(async () => {
  if (ctx === undefined) return
  await dropOwnedTables(ctx)
  await ctx.fiber.dispose()
  ctx = undefined
})

describe.skipIf(target === undefined)('real MySQL account-operation Provider', () => {
  it('serializes the same request id and enforces concurrent stage CAS', async () => {
    const provider = ctx!.accounts.registrationOperations.require()
    const begun = await Promise.all([provider.begin(requestId), provider.begin(requestId)])
    expect(begun[0]).toEqual(begun[1])
    const advances = await Promise.allSettled([
      provider.advance({
        requestId, expectedRevision: 1, expectedStage: 'begun', stage: 'user-created', userId: targetUserId,
      }),
      provider.advance({
        requestId, expectedRevision: 1, expectedStage: 'begun', stage: 'user-created', userId: targetUserId,
      }),
    ])
    expect(advances.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(advances.filter(value => value.status === 'rejected')).toHaveLength(1)
    await provider.advance({
      requestId, expectedRevision: 2, expectedStage: 'user-created', stage: 'identifier-added', userId: targetUserId,
    })
    await provider.advance({
      requestId, expectedRevision: 3, expectedStage: 'identifier-added', stage: 'password-set', userId: targetUserId,
    })
    await expect(provider.complete(requestId, 4, result)).resolves.toMatchObject({ stage: 'completed', result })
    await expect(provider.begin(requestId)).resolves.toMatchObject({ stage: 'completed', result })
  })
})
