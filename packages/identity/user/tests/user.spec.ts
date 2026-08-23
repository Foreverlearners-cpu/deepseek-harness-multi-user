import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import UserService, {
  UserId,
  type CreateUserInput,
  type User,
} from '../src/index.ts'

class MemoryUserService extends UserService {
  readonly records = new Map<string, User>()

  async create(input: CreateUserInput): Promise<User> {
    if (this.records.has(input.id)) {
      throw new Error(`duplicate user: ${input.id}`)
    }
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
    if (!user) throw new Error(`user not found: ${id}`)
    if (user.status !== 'active') throw new Error(`user disabled: ${id}`)
    return user
  }

  async disable(id: UserId): Promise<void> {
    const user = this.records.get(id)
    if (!user) throw new Error(`user not found: ${id}`)
    this.records.set(id, {
      ...user,
      status: 'disabled',
      updatedAt: Date.now(),
      revision: user.revision + 1,
    })
  }

  async list(): Promise<User[]> {
    return [...this.records.values()]
  }
}

describe('UserId', () => {
  it('accepts ASCII identifier characters up to 128 bytes', () => {
    expect(UserId('alice')).toBe('alice')
    expect(UserId('user_1')).toBe('user_1')
    expect(UserId('a.b:c-d_0')).toBe('a.b:c-d_0')
    expect(UserId('A')).toBe('A')
    expect(UserId('x'.repeat(128))).toBe('x'.repeat(128))
  })

  it('rejects empty, non-ASCII, whitespace, and overlong values', () => {
    expect(() => UserId('')).toThrow(TypeError)
    expect(() => UserId('-alice')).toThrow(TypeError)
    expect(() => UserId('.alice')).toThrow(TypeError)
    expect(() => UserId('用户')).toThrow(TypeError)
    expect(() => UserId('a b')).toThrow(TypeError)
    expect(() => UserId('x'.repeat(129))).toThrow(TypeError)
  })
})

describe('UserService', () => {
  it('registers itself as ctx.users', () => {
    const ctx = new Context()
    const users = new MemoryUserService(ctx)
    expect(ctx.users).toBeInstanceOf(MemoryUserService)
    expect((ctx.users as MemoryUserService).records).toBe(users.records)
  })

  it('creates an active user with a revision', async () => {
    const ctx = new Context()
    const users = new MemoryUserService(ctx)
    const created = await users.create({
      id: UserId('alice'),
      displayName: 'Alice',
    })
    expect(created.status).toBe('active')
    expect(created.revision).toBe(1)
    expect(created.displayName).toBe('Alice')
  })

  it('rejects duplicate ids on create', async () => {
    const ctx = new Context()
    const users = new MemoryUserService(ctx)
    const id = UserId('alice')
    await users.create({ id })
    await expect(users.create({ id })).rejects.toThrow(/duplicate user/)
  })

  it('returns undefined for an absent user', async () => {
    const ctx = new Context()
    const users = new MemoryUserService(ctx)
    await expect(users.get(UserId('nobody'))).resolves.toBeUndefined()
  })

  it('requireActive rejects absent and disabled users', async () => {
    const ctx = new Context()
    const users = new MemoryUserService(ctx)
    const id = UserId('alice')
    await expect(users.requireActive(id)).rejects.toThrow(/not found/)
    await users.create({ id })
    await users.disable(id)
    await expect(users.requireActive(id)).rejects.toThrow(/disabled/)
  })

  it('disable preserves the record and bumps revision', async () => {
    const ctx = new Context()
    const users = new MemoryUserService(ctx)
    const id = UserId('alice')
    await users.create({ id })
    await users.disable(id)
    const user = await users.get(id)
    expect(user?.status).toBe('disabled')
    expect(user?.revision).toBe(2)
  })

  it('lists users visible to the runtime', async () => {
    const ctx = new Context()
    const users = new MemoryUserService(ctx)
    await users.create({ id: UserId('alice') })
    await users.create({ id: UserId('bob') })
    const listed = await users.list()
    expect(listed.map(user => user.id)).toEqual(['alice', 'bob'])
  })
})
