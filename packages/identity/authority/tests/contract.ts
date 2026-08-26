/** Shared authorization-decision contract against fixture route Providers. */

import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  authenticationMethod,
  authenticationRequestId,
  type AuthenticatedCall,
} from '@deepseek-ai/dsh-auth'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { describe, expect, it } from 'vitest'
import Authority, {
  actionCode,
  resourceId,
  resourceType,
  type ActionCode,
  type AuthorityRouteProvider,
  type ResourceResolver,
  type TrustedResourceRef,
} from '../src/index.ts'

const ACTION = actionCode('plugin:execute')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')
const TENANT = tenantId('tenant-1')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')

/** Fresh decision runtime used for one conformance case. */
export interface AuthorityContractHarness {
  readonly ctx: Context
  readonly authority: Authority
  readonly call: AuthenticatedCall
}

function resource(team = TEAM_RD): TrustedResourceRef {
  return {
    type: TYPE,
    id: RESOURCE,
    tenantId: TENANT,
    teamId: team,
    revision: 1,
  }
}

function resolver(team = TEAM_RD): ResourceResolver {
  return {
    resolve: ref => Promise.resolve(ref.id === RESOURCE ? resource(team) : undefined),
  }
}

function route(actionsForTeam: Readonly<Record<string, readonly ActionCode[]>>): AuthorityRouteProvider {
  return {
    evaluate: query => Promise.resolve({
      actions: query.set === 'use' ? actionsForTeam[query.teamId] ?? [] : [],
    }),
  }
}

function delegateRoute(use: readonly ActionCode[], delegate: readonly ActionCode[]): AuthorityRouteProvider {
  return {
    evaluate: query => Promise.resolve({
      actions: query.set === 'delegate' ? delegate : use,
    }),
  }
}

/**
 * Run the same-team intersection and fail-closed contract.
 * @param label - Provider label used in the test suite name.
 * @param create - factory returning a live runtime with a current user call.
 */
export function runAuthorityContract(
  label: string,
  create: () => Promise<AuthorityContractHarness>,
): void {
  describe(`authority contract: ${label}`, () => {
    it('allows execute when the same team has the action on both routes', async () => {
      const { authority, call } = await create()
      authority.registerAction({ action: ACTION, resourceType: TYPE })
      authority.registerResolver(TYPE, resolver(TEAM_RD))
      authority.registerRoute('role', route({ [TEAM_RD]: [ACTION] }))
      authority.registerRoute('object', route({ [TEAM_RD]: [ACTION] }))

      await expect(authority.decide({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
      })).resolves.toEqual({
        outcome: 'allow',
        resource: resource(TEAM_RD),
      })
    })

    it('denies when a research-team role is mixed with an operations-team object grant', async () => {
      const { authority, call } = await create()
      authority.registerAction({ action: ACTION, resourceType: TYPE })
      authority.registerResolver(TYPE, resolver(TEAM_OPS))
      authority.registerRoute('role', route({ [TEAM_RD]: [ACTION] }))
      authority.registerRoute('object', route({ [TEAM_OPS]: [ACTION] }))

      await expect(authority.decide({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
      })).resolves.toEqual({ outcome: 'deny', code: 'insufficient-permission' })
    })

    it('denies when only one route contains the action', async () => {
      const { authority, call } = await create()
      authority.registerAction({ action: ACTION, resourceType: TYPE })
      authority.registerResolver(TYPE, resolver())
      authority.registerRoute('role', route({ [TEAM_RD]: [ACTION] }))
      authority.registerRoute('object', route({ [TEAM_RD]: [] }))

      await expect(authority.decide({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
      })).resolves.toEqual({ outcome: 'deny', code: 'insufficient-permission' })

      const { authority: opposite, call: oppositeCall } = await create()
      opposite.registerAction({ action: ACTION, resourceType: TYPE })
      opposite.registerResolver(TYPE, resolver())
      opposite.registerRoute('role', route({ [TEAM_RD]: [] }))
      opposite.registerRoute('object', route({ [TEAM_RD]: [ACTION] }))
      await expect(opposite.decide({
        call: oppositeCall,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
      })).resolves.toEqual({ outcome: 'deny', code: 'insufficient-permission' })
    })

    it('denies when a route Provider or action is missing', async () => {
      const { authority, call } = await create()
      await expect(authority.decide({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
      })).resolves.toEqual({ outcome: 'deny', code: 'unknown-action' })

      authority.registerAction({ action: ACTION, resourceType: TYPE })
      authority.registerResolver(TYPE, resolver())
      authority.registerRoute('role', route({ [TEAM_RD]: [ACTION] }))
      await expect(authority.decide({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
      })).resolves.toEqual({ outcome: 'deny', code: 'missing-provider' })
    })

    it('returns to fail-closed after a route Provider is disposed', async () => {
      const { authority, call } = await create()
      authority.registerAction({ action: ACTION, resourceType: TYPE })
      authority.registerResolver(TYPE, resolver())
      const disposeRole = authority.registerRoute('role', route({ [TEAM_RD]: [ACTION] }))
      authority.registerRoute('object', route({ [TEAM_RD]: [ACTION] }))
      await expect(authority.require({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
      })).resolves.toEqual(resource(TEAM_RD))

      disposeRole()
      await expect(authority.decide({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
      })).resolves.toEqual({ outcome: 'deny', code: 'missing-provider' })
    })

    it('does not consult Delegate sets when deciding Use', async () => {
      const { authority, call } = await create()
      authority.registerAction({ action: ACTION, resourceType: TYPE })
      authority.registerResolver(TYPE, resolver())
      authority.registerRoute('role', delegateRoute([], [ACTION]))
      authority.registerRoute('object', delegateRoute([ACTION], [ACTION]))

      await expect(authority.decide({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
        purpose: 'use',
      })).resolves.toEqual({ outcome: 'deny', code: 'insufficient-permission' })
      await expect(authority.decide({
        call,
        action: ACTION,
        resource: { type: TYPE, id: RESOURCE },
        purpose: 'delegate',
      })).resolves.toMatchObject({ outcome: 'allow' })
    })
  })
}

/** Mount authentication and authority, then mint one current user call.
 * @returns live harness used by the shared contract and local tests.
 */
export async function setupAuthority(): Promise<AuthorityContractHarness> {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  ctx.auth.providers.register('in-process', {
    method: authenticationMethod('local-test'),
    verify: async () => ({
      principal: { kind: 'user', id: userId('user-red') },
      authenticatedAt: Date.now(),
    }),
  })
  const call = await ctx.auth.authenticate({
    requestId: authenticationRequestId('request-1'),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal: new AbortController().signal,
  })
  return { ctx, authority: ctx.authority, call }
}
