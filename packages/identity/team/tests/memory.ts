import type { UserId } from '@deepseek-ai/dsh-user'
import TeamDirectory, {
  TeamDirectoryError,
  teamId,
  teamMembershipId,
  type TeamCreateRecordInput,
  type TeamId,
  type TeamMembershipCreateRecordInput,
  type TeamMembershipListQuery,
  type TeamMembershipMutation,
  type TeamMembershipMutationCommit,
  type TeamMembershipPage,
  type TeamMembershipRecord,
  type TeamMutation,
  type TeamMutationCommit,
  type TeamRecord,
} from '../src/index.ts'

function membershipKey(id: TeamId, member: UserId): string {
  return `${id}\0${member}`
}

/** In-memory Provider used only to exercise the shared directory contract. */
export class MemoryTeamDirectory extends TeamDirectory {
  private readonly teams = new Map<TeamId, TeamRecord>()
  private readonly memberships = new Map<string, TeamMembershipRecord>()
  private teamSequence = 0
  private membershipSequence = 0
  private clock = 1_000

  protected createTeamRecord(input: TeamCreateRecordInput): Promise<TeamRecord> {
    this.teamSequence += 1
    const id = teamId(`team-${String(this.teamSequence)}`)
    const now = this.tick()
    const record: TeamRecord = {
      teamId: id,
      tenantId: input.tenantId,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    this.teams.set(id, record)
    return Promise.resolve(record)
  }

  protected readTeamRecord(id: TeamId): Promise<TeamRecord | undefined> {
    return Promise.resolve(this.teams.get(id))
  }

  protected mutateTeamRecord(mutation: TeamMutation): Promise<TeamMutationCommit> {
    const previous = this.teams.get(mutation.teamId)
    if (previous === undefined) throw new TeamDirectoryError('team-not-found', 'memory team was not found')
    if (previous.revision !== mutation.expectedRevision) {
      throw new TeamDirectoryError('revision-conflict', 'memory team revision changed')
    }
    if (previous.status === 'deleted') throw new TeamDirectoryError('team-deleted', 'memory team is deleted')
    const allowed = mutation.status === 'disabled'
      ? previous.status === 'active'
      : mutation.status === 'active'
        ? previous.status === 'disabled'
        : previous.status === 'active' || previous.status === 'disabled'
    if (!allowed) throw new TeamDirectoryError('status-conflict', 'memory team status conflicts')
    const current: TeamRecord = {
      ...previous,
      status: mutation.status,
      updatedAt: this.tick(),
      revision: previous.revision + 1,
    }
    this.teams.set(current.teamId, current)
    return Promise.resolve({ previous, current })
  }

  protected createMembershipRecord(input: TeamMembershipCreateRecordInput): Promise<TeamMembershipRecord> {
    const key = membershipKey(input.teamId, input.userId)
    const existing = this.memberships.get(key)
    if (existing !== undefined && existing.status !== 'removed') {
      throw new TeamDirectoryError('membership-conflict', 'memory membership already exists')
    }
    this.membershipSequence += 1
    const now = this.tick()
    const record: TeamMembershipRecord = {
      membershipId: teamMembershipId(`membership-${String(this.membershipSequence)}`),
      teamId: input.teamId,
      tenantId: input.tenantId,
      userId: input.userId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    this.memberships.set(key, record)
    return Promise.resolve(record)
  }

  protected readMembershipRecord(id: TeamId, member: UserId): Promise<TeamMembershipRecord | undefined> {
    return Promise.resolve(this.memberships.get(membershipKey(id, member)))
  }

  protected mutateMembershipRecord(mutation: TeamMembershipMutation): Promise<TeamMembershipMutationCommit> {
    const previous = this.memberships.get(membershipKey(mutation.teamId, mutation.userId))
    if (previous === undefined) {
      throw new TeamDirectoryError('membership-not-found', 'memory membership was not found')
    }
    if (previous.revision !== mutation.expectedRevision) {
      throw new TeamDirectoryError('revision-conflict', 'memory membership revision changed')
    }
    if (previous.status === 'removed') {
      throw new TeamDirectoryError('membership-removed', 'memory membership is removed')
    }
    const allowed = mutation.status === 'disabled'
      ? previous.status === 'active'
      : mutation.status === 'active'
        ? previous.status === 'disabled'
        : previous.status === 'active' || previous.status === 'disabled'
    if (!allowed) throw new TeamDirectoryError('status-conflict', 'memory membership status conflicts')
    const current: TeamMembershipRecord = {
      ...previous,
      status: mutation.status,
      updatedAt: this.tick(),
      revision: previous.revision + 1,
    }
    this.memberships.set(membershipKey(current.teamId, current.userId), current)
    return Promise.resolve({ previous, current })
  }

  protected listMembershipRecords(query: TeamMembershipListQuery): Promise<TeamMembershipPage> {
    const offset = query.cursor === undefined ? 0 : Number(query.cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TeamDirectoryError('invalid-input', 'memory cursor is invalid')
    }
    const records = [...this.memberships.values()]
      .filter((record) => {
        if (query.scope === 'team' && record.teamId !== query.teamId) return false
        if (query.scope === 'user' && (record.userId !== query.userId || record.tenantId !== query.tenantId)) {
          return false
        }
        return query.status === undefined || record.status === query.status
      })
      .sort((left, right) => left.membershipId.localeCompare(right.membershipId))
    const memberships = records.slice(offset, offset + query.limit)
    const nextOffset = offset + memberships.length
    return Promise.resolve({
      memberships,
      ...(nextOffset >= records.length ? {} : { nextCursor: String(nextOffset) }),
    })
  }

  private tick(): number {
    this.clock += 1
    return this.clock
  }
}
