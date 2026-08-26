import type { UserId } from '@deepseek-ai/dsh-user'
import TenantDirectory, {
  TenantDirectoryError,
  membershipId,
  tenantId,
  type MembershipCreateRecordInput,
  type MembershipListQuery,
  type MembershipMutation,
  type MembershipMutationCommit,
  type MembershipPage,
  type MembershipRecord,
  type TenantCreateRecordInput,
  type TenantId,
  type TenantMutation,
  type TenantMutationCommit,
  type TenantRecord,
} from '../src/index.ts'

function membershipKey(id: TenantId, member: UserId): string {
  return `${id}\0${member}`
}

/** In-memory Provider used only to exercise the shared directory contract. */
export class MemoryTenantDirectory extends TenantDirectory {
  private readonly tenants = new Map<TenantId, TenantRecord>()
  private readonly memberships = new Map<string, MembershipRecord>()
  private tenantSequence = 0
  private membershipSequence = 0
  private clock = 1_000

  protected createTenantRecord(input: TenantCreateRecordInput): Promise<TenantRecord> {
    this.tenantSequence += 1
    const id = tenantId(`tenant-${String(this.tenantSequence)}`)
    const now = this.tick()
    const record: TenantRecord = {
      tenantId: id,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
    this.tenants.set(id, record)
    return Promise.resolve(record)
  }

  protected readTenantRecord(id: TenantId): Promise<TenantRecord | undefined> {
    return Promise.resolve(this.tenants.get(id))
  }

  protected mutateTenantRecord(mutation: TenantMutation): Promise<TenantMutationCommit> {
    const previous = this.tenants.get(mutation.tenantId)
    if (previous === undefined) throw new TenantDirectoryError('tenant-not-found', 'memory tenant was not found')
    if (previous.revision !== mutation.expectedRevision) {
      throw new TenantDirectoryError('revision-conflict', 'memory tenant revision changed')
    }
    if (previous.status === 'deleted') throw new TenantDirectoryError('tenant-deleted', 'memory tenant is deleted')
    const allowed = mutation.status === 'disabled'
      ? previous.status === 'active'
      : mutation.status === 'active'
        ? previous.status === 'disabled'
        : previous.status === 'active' || previous.status === 'disabled'
    if (!allowed) throw new TenantDirectoryError('status-conflict', 'memory tenant status conflicts')
    const current: TenantRecord = {
      ...previous,
      status: mutation.status,
      updatedAt: this.tick(),
      revision: previous.revision + 1,
    }
    this.tenants.set(current.tenantId, current)
    return Promise.resolve({ previous, current })
  }

  protected createMembershipRecord(input: MembershipCreateRecordInput): Promise<MembershipRecord> {
    const key = membershipKey(input.tenantId, input.userId)
    const existing = this.memberships.get(key)
    if (existing !== undefined && existing.status !== 'removed') {
      throw new TenantDirectoryError('membership-conflict', 'memory membership already exists')
    }
    this.membershipSequence += 1
    const now = this.tick()
    const record: MembershipRecord = {
      membershipId: membershipId(`membership-${String(this.membershipSequence)}`),
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

  protected readMembershipRecord(id: TenantId, member: UserId): Promise<MembershipRecord | undefined> {
    return Promise.resolve(this.memberships.get(membershipKey(id, member)))
  }

  protected mutateMembershipRecord(mutation: MembershipMutation): Promise<MembershipMutationCommit> {
    const previous = this.memberships.get(membershipKey(mutation.tenantId, mutation.userId))
    if (previous === undefined) {
      throw new TenantDirectoryError('membership-not-found', 'memory membership was not found')
    }
    if (previous.revision !== mutation.expectedRevision) {
      throw new TenantDirectoryError('revision-conflict', 'memory membership revision changed')
    }
    if (previous.status === 'removed') {
      throw new TenantDirectoryError('membership-removed', 'memory membership is removed')
    }
    const allowed = mutation.status === 'disabled'
      ? previous.status === 'active'
      : mutation.status === 'active'
        ? previous.status === 'disabled'
        : previous.status === 'active' || previous.status === 'disabled'
    if (!allowed) throw new TenantDirectoryError('status-conflict', 'memory membership status conflicts')
    const current: MembershipRecord = {
      ...previous,
      status: mutation.status,
      updatedAt: this.tick(),
      revision: previous.revision + 1,
    }
    this.memberships.set(membershipKey(current.tenantId, current.userId), current)
    return Promise.resolve({ previous, current })
  }

  protected listMembershipRecords(query: MembershipListQuery): Promise<MembershipPage> {
    const offset = query.cursor === undefined ? 0 : Number(query.cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TenantDirectoryError('invalid-input', 'memory cursor is invalid')
    }
    const records = [...this.memberships.values()]
      .filter((record) => {
        if (query.scope === 'tenant' && record.tenantId !== query.tenantId) return false
        if (query.scope === 'user' && record.userId !== query.userId) return false
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
