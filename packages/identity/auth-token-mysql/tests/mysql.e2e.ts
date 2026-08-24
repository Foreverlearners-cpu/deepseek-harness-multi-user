import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { authenticationRequestId, userId } from '@deepseek-ai/dsh-auth'
import Mysql from '@deepseek-ai/dsh-mysql'
import type { Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'
import AuthTokenMysql from '../src/index.ts'

interface DigestRow extends RowDataPacket { digest: string }
const target = process.env.DSH_MYSQL_TEST_URL
const signal = new AbortController().signal
const requestId = authenticationRequestId('mysql-e2e')
const principal = { kind: 'user' as const, id: userId('mysql-e2e-user') }
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
    await connection.query('DROP TABLE IF EXISTS dsh_auth_refresh_credentials')
    await connection.query('DROP TABLE IF EXISTS dsh_auth_token_families')
    await connection.query('DROP TABLE IF EXISTS dsh_auth_token_schema')
  })
}

beforeEach(async () => {
  if (target === undefined) return
  ctx = new Context()
  await ctx.plugin(Mysql, config())
  await dropOwnedTables(ctx)
  await ctx.plugin(AuthTokenMysql)
})

afterEach(async () => {
  if (ctx === undefined) return
  await dropOwnedTables(ctx)
  await ctx.fiber.dispose()
  ctx = undefined
})

describe.skipIf(target === undefined)('real MySQL auth-token Provider', () => {
  it('rolls back issue and rotation when pre-commit preparation fails', async () => {
    const service = ctx!.authTokens
    await expect(service.issueFamilyWithPreparation(
      { requestId, signal, principal, expiresAt: Date.now() + 60_000 },
      async () => { throw new Error('prepare failed') },
    )).rejects.toMatchObject({ code: 'provider-unavailable' })
    await expect(service.inspect({
      requestId, signal, target: { kind: 'principal', principal },
    })).resolves.toEqual({ families: [], credentials: [] })

    const issued = await service.issueFamily({ requestId, signal, principal, expiresAt: Date.now() + 60_000 })
    await expect(service.rotateWithPreparation(
      { requestId, signal, refreshToken: issued.refreshToken.value },
      async () => { throw new Error('prepare failed') },
    )).rejects.toMatchObject({ code: 'provider-unavailable' })
    const unchanged = await service.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
    })
    expect(unchanged.families).toEqual([expect.objectContaining({ status: 'active', revision: 1 })])
    expect(unchanged.credentials).toEqual([expect.objectContaining({ status: 'active' })])
    await expect(service.rotate({ requestId, signal, refreshToken: issued.refreshToken.value }))
      .resolves.toMatchObject({ family: { status: 'active', revision: 2 } })
  })

  it('stores only digests and atomically handles concurrent rotation, replay, and revocation', async () => {
    const service = ctx!.authTokens
    const issued = await service.issueFamily({ requestId, signal, principal, expiresAt: Date.now() + 60_000 })
    const [digests] = await ctx!.mysql.connection(connection => connection.query<DigestRow[]>(
      'SELECT digest FROM dsh_auth_refresh_credentials WHERE credential_id = ?',
      [issued.refreshToken.credentialId],
    ))
    expect(digests[0]?.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(digests[0]?.digest).not.toContain(issued.refreshToken.value)

    const rotations = await Promise.allSettled([
      service.rotate({ requestId, signal, refreshToken: issued.refreshToken.value }),
      service.rotate({ requestId, signal, refreshToken: issued.refreshToken.value }),
    ])
    expect(rotations.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = rotations.filter(result => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason as unknown).toMatchObject({ code: 'refresh-token-reused' })
    const inspection = await service.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
    })
    expect(inspection.families[0]).toMatchObject({ status: 'revoked', revocationReason: 'refresh-token-reuse' })
    await expect(service.revoke({ requestId, signal, target: { kind: 'principal', principal } })).resolves.toBeUndefined()
  })
})
