import { Context, Service } from '@deepseek-ai/cordis'
import { AccountError } from '@deepseek-ai/dsh-account'
import AuthenticationRuntime, {
  authenticationMethod,
  authenticationRequestId,
  serviceAccountId,
  type ServiceAccountId,
} from '@deepseek-ai/dsh-auth'
import AuthRbac, { MemoryRbacPolicySource, roleId } from '@deepseek-ai/dsh-auth-rbac'
import Authority, { actionCode, resourceId } from '@deepseek-ai/dsh-authority'
import AuthorityAcl, { MemoryAclPolicySource } from '@deepseek-ai/dsh-authority-acl'
import type { TeamId } from '@deepseek-ai/dsh-team'
import type { TenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import { afterEach, describe, expect, it } from 'vitest'
import AccountAuthority, { ACCOUNT_RESOURCE_TYPE } from '../src/index.ts'
import { MemoryTeamDirectory } from '../../team/tests/memory.ts'
import { MemoryTenantDirectory } from '../../tenant/tests/memory.ts'
import { AccountAdministrationStub } from './account-admin-stub.ts'

const ACTOR = userId('user-admin')
const TARGET = userId('user-red')
const RUNNER = roleId('runner')
const ACCOUNT_ACTIONS = Object.freeze([
  actionCode('account:create'),
  actionCode('account:update'),
  actionCode('account:disable'),
  actionCode('account:enable'),
  actionCode('account:reset-password'),
  actionCode('account:revoke-sessions'),
])

let current: Context | undefined
let principal:
  | { readonly kind: 'user'; readonly id: UserId }
  | { readonly kind: 'service-account'; readonly id: ServiceAccountId } = {
    kind: 'user',
    id: ACTOR,
  }

afterEach(async () => {
  await current?.fiber.dispose()
  current = undefined
  principal = { kind: 'user', id: ACTOR }
})

/** Tenant directory that rejects membership scans. */
class FailingTenants extends Service {
  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'tenants')
  }

  /** Reject one membership scan.
   * @returns never settles successfully.
   */
  listUserMemberships(): Promise<never> {
    return Promise.reject(new Error('tenant directory down'))
  }
}

/** Team directory that rejects membership scans. */
class FailingTeams extends Service {
  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'teams')
  }

  /** Reject one team-membership scan.
   * @returns never settles successfully.
   */
  listUserTeams(): Promise<never> {
    return Promise.reject(new Error('team directory down'))
  }
}

interface Stack {
  readonly ctx: Context
  readonly rbac: MemoryRbacPolicySource
  readonly acl: MemoryAclPolicySource
  readonly disposeAuthorizer: (() => Promise<void>) | undefined
}

async function setup(options: {
  readonly authorizer?: boolean
  readonly tenants?: typeof MemoryTenantDirectory | typeof FailingTenants
  readonly teams?: typeof MemoryTeamDirectory | typeof FailingTeams
} = {}): Promise<Stack> {
  const ctx = new Context()
  current = ctx
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  await ctx.plugin(options.tenants ?? MemoryTenantDirectory)
  await ctx.plugin(options.teams ?? MemoryTeamDirectory)
  await ctx.plugin(AuthRbac)
  await ctx.plugin(AuthorityAcl)
  const rbac = new MemoryRbacPolicySource()
  const acl = new MemoryAclPolicySource()
  ctx.authRbac.registerSource(rbac)
  ctx.authorityAcl.registerSource(acl)
  await ctx.plugin(AccountAdministrationStub)
  ctx.auth.providers.register('in-process', {
    method: authenticationMethod('local-test'),
    verify: async () => ({
      principal,
      authenticatedAt: Date.now(),
    }),
  })
  if (options.authorizer === false) return { ctx, rbac, acl, disposeAuthorizer: undefined }
  const authorizerFiber = ctx.plugin(AccountAuthority)
  await authorizerFiber
  return { ctx, rbac, acl, disposeAuthorizer: () => authorizerFiber.dispose() }
}

async function authenticate(ctx: Context) {
  return ctx.auth.authenticate({
    requestId: authenticationRequestId('request-1'),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal: new AbortController().signal,
  })
}

async function uniqueTeam(ctx: Context, users: readonly UserId[], displayName = 'RD') {
  const tenant = await ctx.tenants.create({ displayName: 'Acme' })
  const team = await ctx.teams.create({ tenantId: tenant.tenantId, displayName })
  for (const member of users) {
    await ctx.tenants.addMember({ tenantId: tenant.tenantId, userId: member })
    await ctx.teams.addMember({
      teamId: team.teamId,
      tenantId: tenant.tenantId,
      userId: member,
    })
  }
  return { tenantId: tenant.tenantId, teamId: team.teamId }
}

function grant(
  stack: Stack,
  actor: UserId,
  tenantId: TenantId,
  teamId: TeamId,
  resource: string,
  actions: readonly ReturnType<typeof actionCode>[] = ACCOUNT_ACTIONS,
): void {
  stack.rbac.putRole({ roleId: RUNNER, use: [...actions], delegate: [] })
  stack.rbac.assign({ userId: actor, tenantId, teamId, roleId: RUNNER })
  stack.acl.grant({
    resource: { type: ACCOUNT_RESOURCE_TYPE, id: resourceId(resource) },
    subject: { kind: 'team', id: teamId },
    use: [...actions],
    delegate: [],
  })
}

describe('account-authority authorizer', () => {
  it('fails administrator authorization closed when the wiring plugin is absent', async () => {
    const { ctx } = await setup({ authorizer: false })
    const call = await authenticate(ctx)
    await expect(ctx.accountAdministration.authorizers.authorize(call, 'disable', TARGET))
      .rejects.toMatchObject({
        name: 'AccountError',
        code: 'forbidden',
        message: 'account: administrator authorization was denied',
      })
    expect(ctx.get('accountAuthority')).toBeUndefined()
  })

  it('allows same-team administrator actions through the account registry', async () => {
    const stack = await setup()
    const { tenantId, teamId } = await uniqueTeam(stack.ctx, [ACTOR, TARGET])
    grant(stack, ACTOR, tenantId, teamId, TARGET)
    grant(stack, ACTOR, tenantId, teamId, ACTOR)
    const call = await authenticate(stack.ctx)
    await expect(stack.ctx.accountAdministration.authorizers.authorize(call, 'disable', TARGET))
      .resolves.toBeUndefined()
    await expect(stack.ctx.accountAdministration.authorizers.authorize(call, 'create'))
      .resolves.toBeUndefined()
    for (const action of ['update', 'enable', 'reset-password', 'revoke-sessions'] as const) {
      await expect(stack.ctx.accountAdministration.authorizers.authorize(call, action, TARGET))
        .resolves.toBeUndefined()
    }
  })

  it('denies a target whose unique team is not the actor grant team', async () => {
    const stack = await setup()
    const tenant = await stack.ctx.tenants.create({ displayName: 'Acme' })
    const rd = await stack.ctx.teams.create({ tenantId: tenant.tenantId, displayName: 'RD' })
    const ops = await stack.ctx.teams.create({ tenantId: tenant.tenantId, displayName: 'Ops' })
    await stack.ctx.tenants.addMember({ tenantId: tenant.tenantId, userId: ACTOR })
    await stack.ctx.tenants.addMember({ tenantId: tenant.tenantId, userId: TARGET })
    await stack.ctx.teams.addMember({
      teamId: rd.teamId,
      tenantId: tenant.tenantId,
      userId: ACTOR,
    })
    await stack.ctx.teams.addMember({
      teamId: ops.teamId,
      tenantId: tenant.tenantId,
      userId: TARGET,
    })
    grant(stack, ACTOR, tenant.tenantId, rd.teamId, TARGET)
    const call = await authenticate(stack.ctx)
    await expect(stack.ctx.accountAdministration.authorizers.authorize(call, 'disable', TARGET))
      .rejects.toMatchObject({ name: 'AccountError', code: 'forbidden' })
  })

  it('denies a target that belongs to more than one team without adding an account request field', async () => {
    const stack = await setup()
    const { tenantId, teamId } = await uniqueTeam(stack.ctx, [ACTOR, TARGET])
    const extra = await stack.ctx.teams.create({ tenantId, displayName: 'Ops' })
    await stack.ctx.teams.addMember({ teamId: extra.teamId, tenantId, userId: TARGET })
    grant(stack, ACTOR, tenantId, teamId, TARGET)
    grant(stack, ACTOR, tenantId, extra.teamId, TARGET)
    const call = await authenticate(stack.ctx)
    await expect(stack.ctx.accountAdministration.authorizers.authorize(call, 'disable', TARGET))
      .rejects.toMatchObject({ name: 'AccountError', code: 'forbidden' })
  })

  it('pages membership lists and still resolves a unique team', async () => {
    const stack = await setup()
    const { tenantId, teamId } = await uniqueTeam(stack.ctx, [ACTOR, TARGET])
    const extra = await stack.ctx.tenants.create({ displayName: 'Other' })
    await stack.ctx.tenants.addMember({ tenantId: extra.tenantId, userId: TARGET })
    grant(stack, ACTOR, tenantId, teamId, TARGET)
    const call = await authenticate(stack.ctx)
    await expect(stack.ctx.accountAuthority.authorize({
      actor: call,
      action: 'disable',
      target: TARGET,
    })).resolves.toBeUndefined()
  })

  it('create uses the actor account even when a target is supplied', async () => {
    const stack = await setup()
    const { tenantId, teamId } = await uniqueTeam(stack.ctx, [ACTOR])
    grant(stack, ACTOR, tenantId, teamId, ACTOR, [actionCode('account:create')])
    const call = await authenticate(stack.ctx)
    await expect(stack.ctx.accountAuthority.authorize({
      actor: call,
      action: 'create',
      target: TARGET,
    })).resolves.toBeUndefined()
  })

  it('rejects an unknown action, a missing target, and a non-user principal', async () => {
    const stack = await setup()
    const { tenantId, teamId } = await uniqueTeam(stack.ctx, [ACTOR])
    grant(stack, ACTOR, tenantId, teamId, ACTOR)
    const call = await authenticate(stack.ctx)
    await expect(stack.ctx.accountAuthority.authorize({
      actor: call,
      action: 'approve' as never,
    })).rejects.toThrow(TypeError)
    await expect(stack.ctx.accountAuthority.authorize({
      actor: call,
      action: 'disable',
    })).rejects.toThrow(TypeError)
    principal = { kind: 'service-account', id: serviceAccountId('svc-1') }
    const service = await authenticate(stack.ctx)
    await expect(stack.ctx.accountAuthority.authorize({
      actor: service,
      action: 'create',
    })).rejects.toThrow(TypeError)
  })

  it('rejects an unauthenticated actor before require', async () => {
    const { ctx } = await setup()
    await expect(ctx.accountAuthority.authorize({
      actor: {} as never,
      action: 'disable',
      target: TARGET,
    })).rejects.toMatchObject({ name: 'AuthenticationError' })
  })

  it('fails closed when membership lookup throws', async () => {
    const tenantsDown = await setup({ tenants: FailingTenants })
    const call = await authenticate(tenantsDown.ctx)
    await expect(tenantsDown.ctx.accountAdministration.authorizers.authorize(call, 'disable', TARGET))
      .rejects.toBeInstanceOf(AccountError)
    await current?.fiber.dispose()
    const teamsDown = await setup({ teams: FailingTeams })
    const tenant = await teamsDown.ctx.tenants.create({ displayName: 'Acme' })
    await teamsDown.ctx.tenants.addMember({ tenantId: tenant.tenantId, userId: TARGET })
    const teamCall = await authenticate(teamsDown.ctx)
    await expect(teamsDown.ctx.accountAdministration.authorizers.authorize(teamCall, 'disable', TARGET))
      .rejects.toBeInstanceOf(AccountError)
  })

  it('unregisters the authorizer when the plugin fiber is disposed', async () => {
    const { ctx, disposeAuthorizer } = await setup()
    expect(ctx.get('accountAuthority')).toBeDefined()
    await disposeAuthorizer?.()
    expect(ctx.get('accountAuthority')).toBeUndefined()
    const call = await authenticate(ctx)
    await expect(ctx.accountAdministration.authorizers.authorize(call, 'disable', TARGET))
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it('fails loud when account actions are already catalogued', async () => {
    const { ctx } = await setup({ authorizer: false })
    ctx.authority.registerAction({
      action: actionCode('account:create'),
      resourceType: ACCOUNT_RESOURCE_TYPE,
    })
    await expect(ctx.plugin(AccountAuthority)).rejects.toMatchObject({ code: 'conflict' })
  })
})
