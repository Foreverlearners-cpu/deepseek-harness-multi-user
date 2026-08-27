import { afterEach, beforeEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  teamMembershipId,
  type TeamMembershipListQuery,
  type TeamMembershipPage,
} from '@deepseek-ai/dsh-team'
import { runTeamDirectoryContract } from '../../team/tests/contract.ts'
import TeamMysqlDirectory from '../src/index.ts'
import { decodeCursor, encodeCursor } from '../src/cursor.ts'
import { FakeMysql } from './fake-mysql.ts'

let teamSequence = 0
let membershipSequence = 0
vi.mock('../src/ids.ts', () => ({
  newTeamId: () => `team-${String(++teamSequence)}`,
  newMembershipId: () => `membership-${String(++membershipSequence)}`,
}))

class ContractTeamMysqlDirectory extends TeamMysqlDirectory {
  protected override async listMembershipRecords(query: TeamMembershipListQuery): Promise<TeamMembershipPage> {
    const translated = query.cursor === undefined
      ? query
      : { ...query, cursor: encodeCursor(teamMembershipId(`membership-${query.cursor}`), query) }
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
  teamSequence = 0
  membershipSequence = 0
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

runTeamDirectoryContract('mysql', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', new FakeMysql().asService())
  await ctx.plugin(ContractTeamMysqlDirectory)
  return { ctx, teams: ctx.teams }
})
