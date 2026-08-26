/** Shared role-route contract against a policy source seeded with the standard fixture. */

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
import AuthRbac, { MemoryRbacPolicySource, roleId } from '../src/index.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')
const RUNNER = roleId('runner')
const VIEWER = roleId('viewer')
const READ = actionCode('plugin:read')
const EXECUTE = actionCode('plugin:execute')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')

/** Live role-route evaluator used for one conformance case. */
export interface AuthRbacContractHarness {
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
 * Seed the research-team runner and operations-team viewer fixture.
 * @param source - writable memory source used by the default contract factory.
 */
export function seedStandardRoles(source: MemoryRbacPolicySource): void {
  source.putRole({ roleId: RUNNER, use: [READ, EXECUTE], delegate: [] })
  source.putRole({ roleId: VIEWER, use: [READ], delegate: [] })
  source.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER })
  source.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_OPS, roleId: VIEWER })
}

/**
 * Run the same-team RoleUse / RoleDelegate contract.
 * The factory must bind `user-red` in `tenant-1` as research-team `runner`
 * (`plugin:read`, `plugin:execute`) and operations-team `viewer` (`plugin:read`).
 * @param label - Provider label used in the test suite name.
 * @param create - factory returning a live evaluator over that fixture.
 */
export function runAuthRbacContract(
  label: string,
  create: () => Promise<AuthRbacContractHarness>,
): void {
  describe(`auth-rbac contract: ${label}`, () => {
    it('returns only the operations-team viewer set when asked for that team', async () => {
      const { evaluate } = await create()
      await expect(evaluate(query(TEAM_OPS))).resolves.toEqual({ actions: [READ] })
    })

    it('returns the research-team runner set when asked for that team', async () => {
      const { evaluate } = await create()
      await expect(evaluate(query(TEAM_RD))).resolves.toEqual({ actions: [READ, EXECUTE] })
    })

    it('does not mix Delegate actions into a Use evaluation', async () => {
      const { evaluate } = await create()
      await expect(evaluate(query(TEAM_RD, 'delegate'))).resolves.toEqual({ actions: [] })
      await expect(evaluate(query(TEAM_OPS, 'delegate'))).resolves.toEqual({ actions: [] })
    })
  })
}

/** Mount auth, authority, and RBAC, then register a seeded memory source.
 * @returns live harness used by the shared contract and local tests.
 */
export async function setupAuthRbac(): Promise<{
  readonly ctx: Context
  readonly authRbac: AuthRbac
  readonly source: MemoryRbacPolicySource
  readonly disposeSource: () => void
}> {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  await ctx.plugin(AuthRbac)
  const source = new MemoryRbacPolicySource()
  seedStandardRoles(source)
  const disposeSource = ctx.authRbac.registerSource(source)
  return { ctx, authRbac: ctx.authRbac, source, disposeSource }
}
