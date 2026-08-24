import { afterEach, describe, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runUserCredentialContract } from '@deepseek-ai/dsh-user-credential/testing'
import type { UserId } from '@deepseek-ai/dsh-user-credential'
import UserCredentialMysqlService from '../src/index.ts'
import { FakeMysql } from './fake-mysql.ts'

const contexts: Context[] = []

class ContractUserCredentialMysqlService extends UserCredentialMysqlService {
  verificationWork = 0

  protected override verifyPasswordSecret(userId: UserId | undefined, password: string): Promise<boolean> {
    this.verificationWork += 1
    return super.verifyPasswordSecret(userId, password)
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

runUserCredentialContract({ suite: describe, test: it }, 'mysql', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', new FakeMysql().asService())
  await ctx.plugin(ContractUserCredentialMysqlService)
  const credentials = ctx.userCredentials as ContractUserCredentialMysqlService
  return { ctx, credentials, readPasswordVerificationCount: () => credentials.verificationWork }
})
