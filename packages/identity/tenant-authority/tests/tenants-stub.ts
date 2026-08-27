import { Service } from '@deepseek-ai/cordis'
import { TenantDirectoryError, type TenantDirectoryErrorCode, type TenantId } from '@deepseek-ai/dsh-tenant'
import type { UserId } from '@deepseek-ai/dsh-user/types'

function membershipKey(tenant: TenantId, user: UserId): string {
  return `${tenant}\0${user}`
}

/** Process-local `ctx.tenants` face used to feed live membership into decide. */
export class MemoryTenantMembership extends Service {
  private readonly members = new Set<string>()
  private nextError: Error | undefined

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'tenants')
  }

  /** Mark one user as an active member of one tenant. */
  add(tenant: TenantId, user: UserId): void {
    this.members.add(membershipKey(tenant, user))
  }

  /** Revoke one membership without changing resource rows. */
  kick(tenant: TenantId, user: UserId): void {
    this.members.delete(membershipKey(tenant, user))
  }

  /** Fail the next membership lookup with this error. */
  failNext(error: Error): void {
    this.nextError = error
  }

  /** Fail the next lookup with a tenant-directory category. */
  rejectNext(code: TenantDirectoryErrorCode): void {
    this.nextError = new TenantDirectoryError(code, `tenant: ${code}`)
  }

  /** Require an active membership, or throw a tenant-directory failure.
   * @param id - tenant named by the actor scope.
   * @param member - user on the authority query.
   */
  requireActiveMembership(id: TenantId, member: UserId): Promise<{ readonly status: 'active' }> {
    if (this.nextError !== undefined) {
      const error = this.nextError
      this.nextError = undefined
      return Promise.reject(error)
    }
    if (!this.members.has(membershipKey(id, member))) {
      return Promise.reject(new TenantDirectoryError('membership-not-found', 'tenant: membership was not found'))
    }
    return Promise.resolve({ status: 'active' })
  }
}
