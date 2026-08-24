import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runAuthTokenContract } from '../../auth-token/tests/contract.ts'
import AuthTokenMysql from '../src/index.ts'
import { FakeMysql } from './fake-mysql.ts'

class ContractAuthTokenMysql extends AuthTokenMysql {
  private clock = 1_000
  private sequence = 0

  setTime(value: number): void { this.clock = value }
  protected override now(): number { return this.clock }
  protected override generateId(kind: 'family' | 'refresh'): string { return `${kind}-${String(++this.sequence)}` }
  protected override generateRefreshSecret(): string { return `dsh_rt_secret-${String(++this.sequence)}` }
}

const contexts: Context[] = []
afterEach(async () => Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose())))

runAuthTokenContract('mysql', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', new FakeMysql().asService())
  await ctx.plugin(ContractAuthTokenMysql)
  const authTokens = ctx.authTokens as ContractAuthTokenMysql
  return { ctx, authTokens, setTime: (value) => { authTokens.setTime(value) } }
})
