import { afterEach, beforeEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  membershipId,
  type MembershipListQuery,
  type MembershipPage,
} from '@deepseek-ai/dsh-tenant'
import { runTenantDirectoryContract } from '../../tenant/tests/contract.ts'
import TenantMysqlDirectory from '../src/index.ts'
import { decodeCursor, encodeCursor } from '../src/cursor.ts'
import { FakeMysql } from './fake-mysql.ts'

let tenantSequence = 0
let membershipSequence = 0
vi.mock('../src/ids.ts', () => ({
  newTenantId: () => `tenant-${String(++tenantSequence)}`,
  newMembershipId: () => `membership-${String(++membershipSequence)}`,
}))

class ContractTenantMysqlDirectory extends TenantMysqlDirectory {
  protected override async listMembershipRecords(query: MembershipListQuery): Promise<MembershipPage> {
    const translated = query.cursor === undefined
      ? query
      : { ...query, cursor: encodeCursor(membershipId(`membership-${query.cursor}`), query) }
    const page = await super.listMembershipRecords(translated)
    return {
      memberships: page.memberships,
      ...(page.nextCursor === undefined
        ? {}
        : { nextCursor: decodeCursor(page.nextCursor, query).slice('membership-'.length) }),
    }
  }
}

const contexts: Context[] = []

beforeEach(() => {
  tenantSequence = 0
  membershipSequence = 0
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

runTenantDirectoryContract('mysql', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', new FakeMysql().asService())
  await ctx.plugin(ContractTenantMysqlDirectory)
  return { ctx, tenants: ctx.tenants }
})
