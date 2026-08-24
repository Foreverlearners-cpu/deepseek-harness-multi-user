import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Mysql, { type Config } from '@deepseek-ai/dsh-mysql'
import type { UserId } from '@deepseek-ai/dsh-user-credential'
import UserCredentialMysqlService from '../src/index.ts'

const target = process.env.DSH_MYSQL_TEST_URL
let ctx: Context | undefined
const userId = (value: string): UserId => value as UserId

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

function targetConfig(): Config {
  const url = new URL(target!)
  if (url.protocol !== 'mysql:') throw new Error('DSH_MYSQL_TEST_URL must use the mysql: scheme')
  const database = decodeURIComponent(url.pathname.slice(1))
  if (database.length === 0) throw new Error('DSH_MYSQL_TEST_URL must name a database')
  return {
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 4,
  }
}

describe.skipIf(target === undefined)('real MySQL user credentials', () => {
  it('persists Unicode identifiers and serializes uniqueness and revision races', async () => {
    ctx = new Context()
    await ctx.plugin(Mysql, targetConfig())
    await ctx.plugin(UserCredentialMysqlService)

    const suffix = randomUUID()
    const firstUser = userId(`user-${randomUUID()}`)
    const secondUser = userId(`user-${randomUUID()}`)
    const rawIdentifier = `  ＡLICE-${suffix}@例え.テスト  `
    const normalized = `alice-${suffix}@例え.テスト`
    const competingIdentifiers = await Promise.allSettled([
      ctx.userCredentials.addIdentifier({ userId: firstUser, expectedRevision: 0, kind: 'email', value: rawIdentifier }),
      ctx.userCredentials.addIdentifier({ userId: secondUser, expectedRevision: 0, kind: 'email', value: normalized }),
    ])
    const identifierSuccesses = competingIdentifiers.filter(result => result.status === 'fulfilled')
    const identifierFailures = competingIdentifiers.filter(result => result.status === 'rejected')
    expect(identifierSuccesses).toHaveLength(1)
    expect(identifierFailures).toHaveLength(1)
    expect(identifierFailures[0]).toMatchObject({ reason: { code: 'identifier-conflict' } })

    const owner = await ctx.userCredentials.resolve({ kind: 'email', value: rawIdentifier })
    expect(owner).toBe(identifierSuccesses[0]!.value.userId)
    const base = identifierSuccesses[0]!.value
    const competingPasswords = await Promise.allSettled([
      ctx.userCredentials.setPassword({ userId: base.userId, expectedRevision: base.revision, password: '密碼-one' }),
      ctx.userCredentials.setPassword({ userId: base.userId, expectedRevision: base.revision, password: '密碼-two' }),
    ])
    const passwordSuccesses = competingPasswords.filter(result => result.status === 'fulfilled')
    const passwordFailures = competingPasswords.filter(result => result.status === 'rejected')
    expect(passwordSuccesses).toHaveLength(1)
    expect(passwordFailures).toHaveLength(1)
    expect(passwordFailures[0]).toMatchObject({ reason: { code: 'revision-conflict' } })
    expect(passwordSuccesses[0]!.value).toMatchObject({ passwordEnabled: true, revision: 2 })
  })
})
