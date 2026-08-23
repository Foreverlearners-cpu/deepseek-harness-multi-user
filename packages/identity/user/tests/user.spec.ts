import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import UserDirectory, {
  MAX_USER_DISPLAY_NAME_LENGTH,
  MAX_USER_EXTENSIONS_BYTES,
  MAX_USER_EXTENSIONS_DEPTH,
  MAX_USER_LIST_LIMIT,
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
import { runUserDirectoryContract } from './contract.ts'
import { MemoryUserDirectory } from './memory.ts'

async function setup<T extends UserDirectory>(Provider: new (ctx: Context) => T): Promise<{ ctx: Context; users: T }> {
  const ctx = new Context()
  await ctx.plugin(Provider)
  return { ctx, users: ctx.users as T }
}

runUserDirectoryContract('memory', () => setup(MemoryUserDirectory))

class BrokenUserDirectory extends UserDirectory {
  createFailure: Error | undefined
  readResult: unknown
  mutationResult: unknown
  pageResult: unknown

  constructor(ctx: Context) {
    super(ctx)
    this.createFailure = new Error('database password must not escape')
    this.readResult = undefined
    this.mutationResult = undefined
    this.pageResult = { users: [] }
  }

  protected createRecord(_input: UserCreateRecordInput): Promise<UserRecord> {
    return this.createFailure === undefined
      ? Promise.resolve(this.readResult as UserRecord)
      : Promise.reject(this.createFailure)
  }

  protected readRecord(_id: UserId): Promise<UserRecord | undefined> {
    return Promise.resolve(this.readResult as UserRecord | undefined)
  }

  protected mutateRecord(_mutation: UserMutation): Promise<UserMutationCommit> {
    return Promise.resolve(this.mutationResult as UserMutationCommit)
  }

  protected listRecords(
    _query: Required<Pick<UserListQuery, 'limit'>> & Omit<UserListQuery, 'limit'>,
  ): Promise<UserPage> {
    return Promise.resolve(this.pageResult as UserPage)
  }
}

function record(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: userId('user-1'),
    displayName: 'Before',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    extensions: {},
    ...overrides,
  }
}

function recordWithoutDisplayName(overrides: Partial<Omit<UserRecord, 'displayName'>> = {}): UserRecord {
  return {
    userId: userId('user-1'),
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    extensions: {},
    ...overrides,
  }
}

async function expectInvalidExtension(value: unknown): Promise<void> {
  const { users } = await setup(MemoryUserDirectory)
  await expect(users.create({ extensions: { 'example/value': value as never } })).rejects.toMatchObject({
    code: 'invalid-input',
  })
}

describe('user directory validation', () => {
  it('rejects invalid ids, profile inputs, revisions, contexts, and list queries', async () => {
    const { users } = await setup(MemoryUserDirectory)
    expect(() => userId('bad id')).toThrow(TypeError)
    await expect(users.create({ displayName: '   ' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.create({ extensions: { locale: 'zh-CN' } })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.create({ extensions: [] as never })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.create({ extensions: { 'example/value': Number.NaN } })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(users.create({ displayName: 1 as never })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.create({ displayName: 'x'.repeat(MAX_USER_DISPLAY_NAME_LENGTH + 1) })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    await expect(users.create({ extensions: { 'example/value': circular as never } })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    await expect(users.create({ extensions: { 'example/value': 'x'.repeat(MAX_USER_EXTENSIONS_BYTES) } })).rejects.toMatchObject({
      code: 'invalid-input',
    })
    const created = await users.create()
    await expect(users.update({ userId: created.userId, expectedRevision: 0, patch: { displayName: 'x' } }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.update({ userId: created.userId, expectedRevision: 1, patch: {} }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.disable({
      userId: created.userId,
      expectedRevision: 1,
      context: { correlationId: '', reason: '' },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.disable({
      userId: created.userId,
      expectedRevision: 1,
      context: { reason: '' },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.disable({
      userId: created.userId,
      expectedRevision: 1,
      context: { reason: 'x'.repeat(501) },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.disable({
      userId: created.userId,
      expectedRevision: 1,
      context: { actorUserId: 'bad id' as UserId },
    })).rejects.toThrow(TypeError)
    await expect(users.list({ limit: 0 })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.list({ limit: 1.5 })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.list({ limit: MAX_USER_LIST_LIMIT + 1 })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.list({ cursor: '' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.list({ cursor: 1 as never })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.list({ cursor: 'x'.repeat(1025) })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.list({ status: 'deleted' })).resolves.toMatchObject({ users: [] })
  })

  it('accepts every JSON extension kind and rejects non-JSON containers and properties', async () => {
    const { users } = await setup(MemoryUserDirectory)
    await expect(users.create({
      extensions: {
        'example/all': [null, true, 'text', 2, { nested: false }],
      },
    })).resolves.toMatchObject({ status: 'active' })

    await expectInvalidExtension(undefined)
    await expectInvalidExtension(1n)
    await expectInvalidExtension(new Date())
    const custom = Object.create({ inherited: true }) as Record<string, unknown>
    custom['own'] = true
    await expectInvalidExtension(custom)

    const symbolValue = { [Symbol('secret')]: true }
    await expectInvalidExtension(symbolValue)
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => true })
    await expectInvalidExtension(accessor)
    const hidden: Record<string, unknown> = {}
    Object.defineProperty(hidden, 'value', { enumerable: false, value: true })
    await expectInvalidExtension(hidden)

    let deep: Record<string, unknown> = {}
    const root = deep
    for (let index = 0; index <= MAX_USER_EXTENSIONS_DEPTH; index += 1) {
      const next: Record<string, unknown> = {}
      deep['next'] = next
      deep = next
    }
    await expectInvalidExtension(root)
  })

  it('normalizes unexpected Provider failures and malformed Provider records', async () => {
    const { users } = await setup(BrokenUserDirectory)
    await expect(users.create()).rejects.toEqual(expect.objectContaining({
      name: 'UserDirectoryError',
      code: 'provider-unavailable',
      message: 'user: directory Provider failed',
    }))
    users.createFailure = undefined
    users.readResult = {
      userId: userId('user-1'),
      status: 'active',
      createdAt: 2,
      updatedAt: 1,
      revision: 1,
      extensions: {},
    }
    await expect(users.create()).rejects.toMatchObject({ code: 'provider-unavailable' })
    await expect(users.get(userId('user-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
    users.pageResult = { users: [users.readResult as UserRecord, users.readResult as UserRecord] }
    await expect(users.list()).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    record({ userId: 'bad id' as UserId }),
    record({ status: 'unknown' as never }),
    record({ createdAt: -1 }),
    record({ updatedAt: -1 }),
    record({ revision: 0 }),
    record({ extensions: [] as never }),
    record({ displayName: ' Before ' }),
  ])('rejects malformed Provider record %#', async (badRecord) => {
    const { users } = await setup(BrokenUserDirectory)
    users.readResult = badRecord
    await expect(users.get(userId('user-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    recordWithoutDisplayName({ status: 'disabled' }),
    recordWithoutDisplayName({ revision: 2 }),
    record({ displayName: 'Unexpected' }),
    recordWithoutDisplayName({ extensions: { 'example/value': 1 } }),
  ])('rejects invalid initial Provider record %#', async (badRecord) => {
    const { users } = await setup(BrokenUserDirectory)
    users.createFailure = undefined
    users.readResult = badRecord
    await expect(users.create()).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects malformed mutation commits and inconsistent pages', async () => {
    const { users } = await setup(BrokenUserDirectory)
    const record: UserRecord = {
      userId: userId('user-1'),
      displayName: 'Before',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      extensions: {},
    }
    users.mutationResult = { previous: record, current: { ...record, displayName: 'Wrong', revision: 2, updatedAt: 2 } }
    await expect(users.update({
      userId: record.userId,
      expectedRevision: 1,
      patch: { displayName: 'Expected' },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
    users.pageResult = { users: [record, record] }
    await expect(users.list()).rejects.toMatchObject({ code: 'provider-unavailable' })
    users.pageResult = { users: [{ ...record, status: 'disabled' }] }
    await expect(users.list({ status: 'active' })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    undefined,
    { previous: record({ userId: userId('other') }), current: record({ displayName: 'Expected', revision: 2, updatedAt: 2 }) },
    { previous: record(), current: record({ userId: userId('other'), displayName: 'Expected', revision: 2, updatedAt: 2 }) },
    { previous: record({ revision: 2 }), current: record({ displayName: 'Expected', revision: 3, updatedAt: 2 }) },
    { previous: record(), current: record({ displayName: 'Expected', revision: 3, updatedAt: 2 }) },
    { previous: record(), current: record({ displayName: 'Expected', createdAt: 2, revision: 2, updatedAt: 2 }) },
    { previous: record({ updatedAt: 2 }), current: record({ displayName: 'Expected', revision: 2, updatedAt: 1 }) },
    { previous: record({ status: 'deleted' }), current: record({ status: 'deleted', displayName: 'Expected', revision: 2, updatedAt: 2 }) },
    { previous: record(), current: record({ status: 'disabled', displayName: 'Expected', revision: 2, updatedAt: 2 }) },
    { previous: record(), current: record({ displayName: 'Expected', revision: 2, updatedAt: 2, extensions: { 'example/x': 1 } }) },
  ])('rejects inconsistent profile mutation commit %#', async (commit) => {
    const { users } = await setup(BrokenUserDirectory)
    users.mutationResult = commit
    await expect(users.update({
      userId: userId('user-1'),
      expectedRevision: 1,
      patch: { displayName: 'Expected' },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    { method: 'disable' as const, previous: record({ status: 'disabled' }), current: record({ status: 'disabled', revision: 2, updatedAt: 2 }) },
    { method: 'disable' as const, previous: record(), current: record({ status: 'active', revision: 2, updatedAt: 2 }) },
    { method: 'disable' as const, previous: record(), current: record({ status: 'disabled', displayName: 'Changed', revision: 2, updatedAt: 2 }) },
    { method: 'disable' as const, previous: record(), current: record({ status: 'disabled', revision: 2, updatedAt: 2, extensions: { 'example/x': 1 } }) },
    { method: 'delete' as const, previous: record({ status: 'deleted' }), current: record({ status: 'deleted', revision: 2, updatedAt: 2 }) },
    { method: 'enable' as const, previous: record({ status: 'active' }), current: record({ status: 'active', revision: 2, updatedAt: 2 }) },
  ])('rejects inconsistent status mutation commit %#', async ({ method, previous, current }) => {
    const { users } = await setup(BrokenUserDirectory)
    users.mutationResult = { previous, current }
    await expect(users[method]({ userId: userId('user-1'), expectedRevision: 1 })).rejects.toMatchObject({
      code: 'provider-unavailable',
    })
  })

  it.each([
    null,
    {},
    { users: 'not-an-array' },
    { users: [record(), record({ userId: userId('user-2') })] },
    { users: [], nextCursor: 1 },
    { users: [], nextCursor: '' },
    { users: [], nextCursor: 'x'.repeat(1025) },
  ])('rejects malformed Provider page %#', async (page) => {
    const { users } = await setup(BrokenUserDirectory)
    users.pageResult = page
    await expect(users.list({ limit: 1 })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('contains listener failures and still notifies later listeners', async () => {
    const { ctx, users } = await setup(MemoryUserDirectory)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const observed = vi.fn()
    ctx.on('user/changed', () => { throw new Error('listener failed') })
    ctx.on('user/changed', observed)

    await expect(users.create()).resolves.toMatchObject({ status: 'active' })
    expect(observed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
  })

  it('contains asynchronous listener rejection and rethrows invariant failures after fan-out', async () => {
    const { ctx, users } = await setup(MemoryUserDirectory)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const observed = vi.fn()
    const asyncListener = (() => Promise.reject(new Error('async listener failed'))) as unknown as () => void
    const nullListener = (() => null) as unknown as () => void
    ctx.on('user/changed', asyncListener)
    ctx.on('user/changed', nullListener)
    await users.create()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()

    ctx.on('user/changed', () => { throw Object.assign(new Error('invariant failed'), { code: 'INVARIANT' }) })
    ctx.on('user/changed', observed)
    await expect(users.create()).rejects.toThrow('invariant failed')
    expect(observed).toHaveBeenCalledOnce()
  })
})

describe('user-directory errors', () => {
  it('preserves stable errors and their causes', () => {
    const cause = new Error('cause')
    const error = new UserDirectoryError('provider-unavailable', 'safe', { cause })
    expect(error).toMatchObject({ name: 'UserDirectoryError', code: 'provider-unavailable', message: 'safe', cause })
  })
})
