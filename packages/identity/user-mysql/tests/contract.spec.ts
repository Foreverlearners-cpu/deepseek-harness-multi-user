import { afterEach, beforeEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { userId, type UserListQuery, type UserPage } from '@deepseek-ai/dsh-user'
import { runUserDirectoryContract } from '../../user/tests/contract.ts'
import UserMysqlDirectory from '../src/index.ts'
import { decodeCursor, encodeCursor } from '../src/cursor.ts'
import { FakeMysql } from './fake-mysql.ts'

let sequence = 0
vi.mock('node:crypto', () => ({ randomUUID: () => `user-${String(++sequence)}` }))

class ContractUserMysqlDirectory extends UserMysqlDirectory {
  protected override async listRecords(
    query: Required<Pick<UserListQuery, 'limit'>> & Omit<UserListQuery, 'limit'>,
  ): Promise<UserPage> {
    const translated = query.cursor === undefined
      ? query
      : { ...query, cursor: encodeCursor(userId(`user-${query.cursor}`), query.status) }
    const page = await super.listRecords(translated)
    return {
      users: page.users,
      ...(page.nextCursor === undefined
        ? {}
        : { nextCursor: decodeCursor(page.nextCursor, query.status).slice('user-'.length) }),
    }
  }
}

const contexts: Context[] = []

beforeEach(() => {
  sequence = 0
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

runUserDirectoryContract('mysql', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', new FakeMysql().asService())
  await ctx.plugin(ContractUserMysqlDirectory)
  return { ctx, users: ctx.users }
})
