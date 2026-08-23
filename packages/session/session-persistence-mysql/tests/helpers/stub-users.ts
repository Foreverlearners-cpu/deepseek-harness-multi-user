import { Context } from '@deepseek-ai/cordis'
import { UserId, UserService, type CreateUserInput, type User } from '@deepseek-ai/dsh-user'

/** In-memory users service so provider tests do not depend on an unmerged MySQL user provider. */
export class StubUsers extends UserService {
  readonly records = new Map<string, User>()

  constructor(ctx: Context, config: { active?: string; disabled?: string } = {}) {
    super(ctx)
    const now = Date.now()
    for (const id of config.active === undefined ? [] : [config.active]) {
      const userId = UserId(id)
      this.records.set(userId, { id: userId, status: 'active', createdAt: now, updatedAt: now, revision: 1 })
    }
    for (const id of config.disabled === undefined ? [] : [config.disabled]) {
      const userId = UserId(id)
      this.records.set(userId, { id: userId, status: 'disabled', createdAt: now, updatedAt: now, revision: 2 })
    }
  }

  async create(input: CreateUserInput): Promise<User> {
    const now = Date.now()
    const user: User = {
      id: input.id,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    }
    this.records.set(input.id, user)
    return user
  }

  async get(id: UserId): Promise<User | undefined> {
    return this.records.get(id)
  }

  async requireActive(id: UserId): Promise<User> {
    const user = this.records.get(id)
    if (!user) throw new Error(`user "${String(id)}" not found`)
    if (user.status !== 'active') throw new Error(`user "${String(id)}" is not active`)
    return user
  }

  async disable(id: UserId): Promise<void> {
    const user = this.records.get(id)
    if (!user) throw new Error(`user "${String(id)}" not found`)
    this.records.set(id, { ...user, status: 'disabled', updatedAt: Date.now(), revision: user.revision + 1 })
  }

  async list(): Promise<User[]> {
    return [...this.records.values()]
  }
}
