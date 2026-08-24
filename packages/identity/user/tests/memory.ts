import UserDirectory, {
  UserDirectoryError,
  userId,
  type UserCreateRecordInput,
  type UserId,
  type UserListQuery,
  type UserMutation,
  type UserMutationCommit,
  type UserPage,
  type UserRecord,
} from '../src/index.ts'

/** In-memory Provider used only to exercise the shared directory contract. */
export class MemoryUserDirectory extends UserDirectory {
  private readonly records = new Map<UserId, UserRecord>()
  private sequence = 0
  private clock = 1_000

  protected createRecord(input: UserCreateRecordInput): Promise<UserRecord> {
    this.sequence += 1
    const id = userId(`user-${String(this.sequence)}`)
    const now = this.tick()
    const record: UserRecord = {
      userId: id,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      extensions: input.extensions,
    }
    this.records.set(id, record)
    return Promise.resolve(record)
  }

  protected readRecord(id: UserId): Promise<UserRecord | undefined> {
    return Promise.resolve(this.records.get(id))
  }

  protected mutateRecord(mutation: UserMutation): Promise<UserMutationCommit> {
    const previous = this.records.get(mutation.userId)
    if (previous === undefined) throw new UserDirectoryError('user-not-found', 'memory user was not found')
    if (previous.revision !== mutation.expectedRevision) {
      throw new UserDirectoryError('revision-conflict', 'memory user revision changed')
    }

    let current: UserRecord
    if (mutation.kind === 'profile') {
      if (previous.status === 'deleted') throw new UserDirectoryError('user-deleted', 'memory user is deleted')
      const name = Object.hasOwn(mutation.patch, 'displayName')
        ? mutation.patch.displayName ?? undefined
        : previous.displayName
      const withoutDisplayName = { ...previous }
      delete withoutDisplayName.displayName
      current = {
        ...withoutDisplayName,
        ...(name === undefined ? {} : { displayName: name }),
        ...(mutation.patch.extensions === undefined ? {} : { extensions: mutation.patch.extensions }),
        updatedAt: this.tick(),
        revision: previous.revision + 1,
      }
    } else {
      if (previous.status === 'deleted') throw new UserDirectoryError('user-deleted', 'memory user is deleted')
      const allowed = mutation.status === 'disabled'
        ? previous.status === 'active'
        : mutation.status === 'active'
          ? previous.status === 'disabled'
          : previous.status === 'active' || previous.status === 'disabled'
      if (!allowed) throw new UserDirectoryError('status-conflict', 'memory user status conflicts')
      current = {
        ...previous,
        status: mutation.status,
        updatedAt: this.tick(),
        revision: previous.revision + 1,
      }
    }
    this.records.set(current.userId, current)
    return Promise.resolve({ previous, current })
  }

  protected listRecords(
    query: Required<Pick<UserListQuery, 'limit'>> & Omit<UserListQuery, 'limit'>,
  ): Promise<UserPage> {
    const offset = query.cursor === undefined ? 0 : Number(query.cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new UserDirectoryError('invalid-input', 'memory cursor is invalid')
    }
    const records = [...this.records.values()]
      .filter(record => query.status === undefined || record.status === query.status)
      .sort((left, right) => left.userId.localeCompare(right.userId))
    const users = records.slice(offset, offset + query.limit)
    const nextOffset = offset + users.length
    return Promise.resolve({
      users,
      ...(nextOffset >= records.length ? {} : { nextCursor: String(nextOffset) }),
    })
  }

  private tick(): number {
    this.clock += 1
    return this.clock
  }
}
