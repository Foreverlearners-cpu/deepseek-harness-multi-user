/**
 * Account-administration authorizer that wires `ctx.accountAdministration` to `ctx.authority.require`.
 * @module @deepseek-ai/dsh-account-authority
 */

import { Service } from '@deepseek-ai/cordis'
import type {
  AccountAdminAction,
  AccountAdminAuthorizationRequest,
  AccountAdminAuthorizer,
} from '@deepseek-ai/dsh-account'
import type { AuthenticatedCall } from '@deepseek-ai/dsh-auth'
import {
  actionCode,
  resourceId,
  resourceType,
  type ActionCode,
  type ResourceType,
  type TrustedResourceRef,
} from '@deepseek-ai/dsh-authority'
import type { TeamId } from '@deepseek-ai/dsh-team'
import type { TenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'

/** Resource class for account-administration decisions. */
export const ACCOUNT_RESOURCE_TYPE = resourceType('account')
/** Trusted revision for account resources. This package does not version account rows. */
export const ACCOUNT_RESOURCE_REVISION = 1

const MEMBERSHIP_PAGE_LIMIT = 1

const ACTIONS = Object.freeze({
  create: actionCode('account:create'),
  update: actionCode('account:update'),
  disable: actionCode('account:disable'),
  enable: actionCode('account:enable'),
  'reset-password': actionCode('account:reset-password'),
  'revoke-sessions': actionCode('account:revoke-sessions'),
}) satisfies { readonly [K in AccountAdminAction]: ActionCode }

const CATALOG = Object.freeze(Object.values(ACTIONS))

interface AuthorityFace {
  registerAction(definition: { action: ActionCode; resourceType: ResourceType }): () => void
  registerResolver(
    type: ResourceType,
    resolver: { resolve(pointer: { type: ResourceType; id: string }): Promise<TrustedResourceRef | undefined> },
  ): () => void
  require(request: {
    call: AuthenticatedCall
    action: ActionCode
    resource: { type: ResourceType; id: string }
  }): Promise<TrustedResourceRef>
}

interface AccountAdministrationFace {
  authorizers: { register(provider: AccountAdminAuthorizer): () => void }
}

interface AuthFace {
  assertCurrent(value: unknown): AuthenticatedCall
}

interface TenantMembershipPage {
  readonly memberships: readonly { readonly tenantId: TenantId }[]
  readonly nextCursor?: string
}

interface TeamMembershipPage {
  readonly memberships: readonly { readonly tenantId: TenantId; readonly teamId: TeamId }[]
  readonly nextCursor?: string
}

interface TenantFace {
  listUserMemberships(query: {
    userId: UserId
    status: 'active'
    limit: number
    cursor?: string
  }): Promise<TenantMembershipPage>
}

interface TeamFace {
  listUserTeams(query: {
    userId: UserId
    tenantId: TenantId
    status: 'active'
    limit: number
    cursor?: string
  }): Promise<TeamMembershipPage>
}

function catalogAction(action: string): ActionCode {
  if (!Object.hasOwn(ACTIONS, action)) {
    throw new TypeError('account-authority: action is not an administrator action')
  }
  return ACTIONS[action as AccountAdminAction]
}

function actorUserId(call: AuthenticatedCall): string {
  if (call.principal.kind !== 'user') {
    throw new TypeError('account-authority: only a user principal may authorize account administration')
  }
  return call.principal.id
}

function targetUserId(target: UserId | undefined): string {
  if (target === undefined) {
    throw new TypeError('account-authority: this action requires a target user')
  }
  return target
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Account-administration authorizer that delegates allow or deny to `ctx.authority.require`. */
    accountAuthority: AccountAuthority
  }
}

/**
 * Account-administration wiring. It registers the unique authorizer, catalogues
 * `account:*` actions, resolves an account resource to the user's unique team,
 * and never computes Effective or stores grants.
 */
export class AccountAuthority extends Service implements AccountAdminAuthorizer {
  static inject = ['auth', 'authority', 'accountAdministration', 'tenants', 'teams']

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'accountAuthority')
    this.ctx.effect(() => {
      const authority = this.authority()
      const disposers = CATALOG.map(action => authority.registerAction({
        action,
        resourceType: ACCOUNT_RESOURCE_TYPE,
      }))
      disposers.push(authority.registerResolver(ACCOUNT_RESOURCE_TYPE, {
        resolve: pointer => this.resolveAccount(pointer),
      }))
      disposers.push(this.accountAdministration().authorizers.register(this))
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    })
  }

  /** Assert the actor is current, then require the mapped account action on the unique team.
   * @param request - current actor, administrator action, and optional target user.
   */
  async authorize(request: AccountAdminAuthorizationRequest): Promise<void> {
    const call = this.auth().assertCurrent(request.actor)
    const action = catalogAction(request.action)
    const id = request.action === 'create' ? actorUserId(call) : targetUserId(request.target)
    await this.authority().require({
      call,
      action,
      resource: { type: ACCOUNT_RESOURCE_TYPE, id },
    })
  }

  private async resolveAccount(
    pointer: { type: ResourceType; id: string },
  ): Promise<TrustedResourceRef | undefined> {
    const id = resourceId(pointer.id)
    const member = userId(id)
    const scopes: Array<{ readonly tenantId: TenantId; readonly teamId: TeamId }> = []
    for (const tenantId of await this.listTenantIds(member)) {
      for (const teamId of await this.listTeamIds(member, tenantId)) {
        scopes.push({ tenantId, teamId })
      }
    }
    const scope = scopes.length === 1 ? scopes[0] : undefined
    if (scope === undefined) return undefined
    return Object.freeze({
      type: pointer.type,
      id,
      tenantId: scope.tenantId,
      teamId: scope.teamId,
      revision: ACCOUNT_RESOURCE_REVISION,
    })
  }

  private async listTenantIds(member: UserId): Promise<readonly TenantId[]> {
    const ids: TenantId[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await this.tenants().listUserMemberships({
        userId: member,
        status: 'active',
        limit: MEMBERSHIP_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const row of page.memberships) ids.push(row.tenantId)
      if (page.nextCursor === undefined) return ids
      cursor = page.nextCursor
    }
  }

  private async listTeamIds(member: UserId, tenant: TenantId): Promise<readonly TeamId[]> {
    const ids: TeamId[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await this.teams().listUserTeams({
        userId: member,
        tenantId: tenant,
        status: 'active',
        limit: MEMBERSHIP_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const row of page.memberships) ids.push(row.teamId)
      if (page.nextCursor === undefined) return ids
      cursor = page.nextCursor
    }
  }

  private authority(): AuthorityFace {
    return this.ctx.get('authority') as AuthorityFace
  }

  private accountAdministration(): AccountAdministrationFace {
    return this.ctx.get('accountAdministration') as AccountAdministrationFace
  }

  private auth(): AuthFace {
    return this.ctx.get('auth') as AuthFace
  }

  private tenants(): TenantFace {
    return this.ctx.get('tenants') as TenantFace
  }

  private teams(): TeamFace {
    return this.ctx.get('teams') as TeamFace
  }
}

export default AccountAuthority
