import { Context } from '@deepseek-ai/cordis'
import Mysql, { type Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Starter from '../src/index.ts'

const target = process.env.DSH_MYSQL_TEST_URL
const signal = new AbortController().signal
let ctx: Context | undefined

function mysqlConfig(): MysqlConfig {
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
    for (const table of [
      'dsh_user_login_identifiers', 'dsh_user_credentials',
      'dsh_auth_refresh_credentials', 'dsh_auth_token_families',
      'dsh_account_registration_operations', 'dsh_users',
      'dsh_user_credential_schema', 'dsh_auth_token_schema', 'dsh_account_schema', 'dsh_user_schema',
    ]) {
      await connection.query(`DROP TABLE IF EXISTS ${table}`)
    }
  })
}

beforeEach(async () => {
  if (target === undefined) return
  const cleanup = new Context()
  await cleanup.plugin(Mysql, mysqlConfig())
  await dropOwnedTables(cleanup)
  await cleanup.fiber.dispose()

  ctx = new Context()
  await ctx.plugin(Starter, {
    mysql: mysqlConfig(),
    jwt: {
      issuer: 'https://issuer.example',
      audience: 'dsh-mysql-e2e',
      activeKeyId: 'primary',
      keys: [{ keyId: 'primary', secret: Buffer.alloc(32, 9).toString('base64url') }],
    },
    gateway: { allowedOrigins: ['https://app.example'] },
  })
})

afterEach(async () => {
  if (ctx === undefined) return
  await dropOwnedTables(ctx)
  await ctx.fiber.dispose()
  ctx = undefined
})

describe.skipIf(target === undefined)('complete authentication suite over real MySQL', () => {
  it('registers, logs in, authenticates, rotates refresh, and logs out', async () => {
    const gateway = ctx!.authGateway
    const user = await gateway.register({
      requestId: 'starter-mysql-register', signal,
      identifier: { kind: 'username', value: 'mysql-user' },
      password: 'correct horse battery staple',
    })
    const login = await gateway.login({
      requestId: 'starter-mysql-login', signal,
      identifier: { kind: 'username', value: 'mysql-user' },
      password: 'correct horse battery staple',
    })
    const call = await gateway.authenticateHttp({
      requestId: 'starter-mysql-access', signal,
      headers: [{ name: 'Authorization', value: `Bearer ${login.accessToken}` }],
    })
    expect(call.principal).toEqual({ kind: 'user', id: user.userId })
    const refresh = login.cookies.find(value => value.name === '__Host-dsh_refresh')!.value
    const csrf = login.cookies.find(value => value.name === '__Host-dsh_csrf')!.value
    const rotated = await gateway.refresh({
      requestId: 'starter-mysql-refresh', signal,
      headers: [{ name: 'Origin', value: 'https://app.example' }, { name: 'X-DSH-CSRF', value: csrf }],
      cookies: [
        { name: '__Host-dsh_refresh', value: refresh },
        { name: '__Host-dsh_csrf', value: csrf },
      ],
    })
    const logout = await gateway.logout({
      requestId: 'starter-mysql-logout', signal,
      headers: [{ name: 'Authorization', value: `Bearer ${rotated.accessToken}` }],
    })
    expect(logout.cookies.every(value => value.maxAgeSeconds === 0)).toBe(true)
  })
})
