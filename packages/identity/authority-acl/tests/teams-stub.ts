import { Service } from '@deepseek-ai/cordis'
import { TeamDirectoryError, type TeamDirectoryErrorCode, type TeamId } from '@deepseek-ai/dsh-team'
import type { UserId } from '@deepseek-ai/dsh-user/types'

function membershipKey(team: TeamId, user: UserId): string {
  return `${team}\0${user}`
}

/** Process-local `ctx.teams` face used to feed live membership into evaluate. */
export class MemoryTeamMembership extends Service {
  private readonly members = new Set<string>()
  private nextError: Error | undefined

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'teams')
  }

  /** Mark one user as an active member of one team. */
  add(team: TeamId, user: UserId): void {
    this.members.add(membershipKey(team, user))
  }

  /** Revoke one membership without changing object-grant rows. */
  kick(team: TeamId, user: UserId): void {
    this.members.delete(membershipKey(team, user))
  }

  /** Fail the next membership lookup with this error. */
  failNext(error: Error): void {
    this.nextError = error
  }

  /** Fail the next lookup with a team-directory category. */
  rejectNext(code: TeamDirectoryErrorCode): void {
    this.nextError = new TeamDirectoryError(code, `team: ${code}`)
  }

  /** Require an active membership, or throw a team-directory failure.
   * @param id - team named by a team-subject grant.
   * @param member - user on the authority query.
   */
  requireActiveMembership(id: TeamId, member: UserId): Promise<{ readonly status: 'active' }> {
    if (this.nextError !== undefined) {
      const error = this.nextError
      this.nextError = undefined
      return Promise.reject(error)
    }
    if (!this.members.has(membershipKey(id, member))) {
      return Promise.reject(new TeamDirectoryError('membership-not-found', 'team: membership was not found'))
    }
    return Promise.resolve({ status: 'active' })
  }
}
