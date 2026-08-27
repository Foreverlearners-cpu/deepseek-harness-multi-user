/** Shared object-route contract against a policy source seeded with the standard fixture. */

import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Authority, {
  actionCode,
  resourceId,
  resourceType,
  type AuthorityRouteQuery,
  type AuthorityRouteResult,
  type TrustedResourceRef,
} from '@deepseek-ai/dsh-authority'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { describe, expect, it } from 'vitest'
import AuthorityAcl, {
  aclSubjectRef,
  MemoryAclPolicySource,
  MemoryAclRoleFactSource,
} from '../src/index.ts'
import { MemoryTeamMembership } from './teams-stub.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')
const EXECUTE = actionCode('plugin:execute')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')

/** Live object-route evaluator used for one conformance case. */
export interface AuthorityAclContractHarness {
  readonly evaluate: (query: AuthorityRouteQuery) => Promise<AuthorityRouteResult>
}

function resource(team: ReturnType<typeof teamId>): TrustedResourceRef {
  return {
    type: TYPE,
    id: RESOURCE,
    tenantId: TENANT,
    teamId: team,
    revision: 1,
  }
}

function query(team: ReturnType<typeof teamId>, set: 'use' | 'delegate' = 'use'): AuthorityRouteQuery {
  return {
    userId: USER,
    tenantId: TENANT,
    teamId: team,
    action: EXECUTE,
    resource: resource(team),
    set,
  }
}

/**
 * Seed one execute grant on `g:team-rd` and place the user on both teams.
 * @param source - writable memory source used by the default contract factory.
 * @param teams - live membership table used as `ctx.teams`.
 */
export function seedStandardGrants(source: MemoryAclPolicySource, teams: MemoryTeamMembership): void {
  source.grant({
    resource: { type: TYPE, id: RESOURCE },
    subject: { kind: 'team', id: TEAM_RD },
    use: [EXECUTE],
    delegate: [],
  })
  teams.add(TEAM_RD, USER)
  teams.add(TEAM_OPS, USER)
}

/**
 * Run the same-team ObjectUse / ObjectDelegate contract.
 * The factory must grant `plugin:execute` to `g:team-rd` only, keep the user
 * on both teams, and read membership from the team service.
 * @param label - Provider label used in the test suite name.
 * @param create - factory returning a live evaluator over that fixture.
 */
export function runAuthorityAclContract(
  label: string,
  create: () => Promise<AuthorityAclContractHarness>,
): void {
  describe(`authority-acl contract: ${label}`, () => {
    it('omits the research-team grant when asked for the operations team', async () => {
      const { evaluate } = await create()
      await expect(evaluate(query(TEAM_OPS))).resolves.toEqual({ actions: [] })
    })

    it('returns execute when asked for the research team while the user is a member', async () => {
      const { evaluate } = await create()
      await expect(evaluate(query(TEAM_RD))).resolves.toEqual({ actions: [EXECUTE] })
    })

    it('does not mix Delegate actions into a Use evaluation', async () => {
      const { evaluate } = await create()
      await expect(evaluate(query(TEAM_RD, 'delegate'))).resolves.toEqual({ actions: [] })
      await expect(evaluate(query(TEAM_OPS, 'delegate'))).resolves.toEqual({ actions: [] })
    })
  })
}

/** Mount auth, authority, team membership, and ACL, then register a seeded source.
 * @returns live harness used by the shared contract and local tests.
 */
export async function setupAuthorityAcl(): Promise<{
  readonly ctx: Context
  readonly authorityAcl: AuthorityAcl
  readonly source: MemoryAclPolicySource
  readonly roles: MemoryAclRoleFactSource
  readonly teams: MemoryTeamMembership
  readonly disposeSource: () => void
  readonly disposeRoles: () => void
}> {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  await ctx.plugin(MemoryTeamMembership)
  await ctx.plugin(AuthorityAcl)
  const source = new MemoryAclPolicySource()
  const roles = new MemoryAclRoleFactSource()
  const teams = ctx.get('teams') as unknown as MemoryTeamMembership
  seedStandardGrants(source, teams)
  const disposeSource = ctx.authorityAcl.registerSource(source)
  const disposeRoles = ctx.authorityAcl.registerRoleFacts(roles)
  expect(aclSubjectRef({ kind: 'team', id: TEAM_RD })).toBe('g:team-rd')
  expect(await source.listGrants({ type: TYPE, id: RESOURCE })).toHaveLength(1)
  return {
    ctx,
    authorityAcl: ctx.authorityAcl,
    source,
    roles,
    teams,
    disposeSource,
    disposeRoles,
  }
}
