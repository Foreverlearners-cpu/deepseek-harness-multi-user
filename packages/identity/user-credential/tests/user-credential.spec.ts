import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import UserCredentialService, {
  MAX_LOGIN_IDENTIFIER_BYTES,
  MAX_PASSWORD_BYTES,
  UserCredentialError,
  type LoginIdentifier,
  type LoginIdentifierInput,
  type UserCredentialMutation,
  type UserCredentialMutationCommit,
  type UserCredentialRecord,
  type UserId,
} from '../src/index.ts'
import { runUserCredentialContract } from './contract.ts'
import { MemoryUserCredentialService } from './memory.ts'

const id = (value: string): UserId => value as UserId

function record(overrides: Partial<UserCredentialRecord> = {}): UserCredentialRecord {
  return {
    userId: id('user-1'),
    revision: 1,
    identifiers: [],
    passwordEnabled: false,
    updatedAt: 1,
    ...overrides,
  }
}

async function setup<T extends UserCredentialService>(Provider: new (ctx: Context) => T): Promise<{ ctx: Context; credentials: T }> {
  const ctx = new Context()
  await ctx.plugin(Provider)
  return { ctx, credentials: ctx.userCredentials as T }
}

runUserCredentialContract('memory', () => setup(MemoryUserCredentialService))

class BrokenCredentialService extends UserCredentialService {
  normalizeResult: unknown = 'normalized'
  readResult: unknown
  resolveResult: unknown
  mutationResult: unknown
  verifyResult: unknown = false
  failure: Error | undefined

  protected normalizeLoginIdentifier(_input: LoginIdentifierInput): Promise<string> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(this.normalizeResult as string)
  }
  protected readCredentialRecord(_userId: UserId): Promise<UserCredentialRecord | undefined> {
    return Promise.resolve(this.readResult as UserCredentialRecord | undefined)
  }
  protected resolveLoginIdentifier(_identifier: LoginIdentifier): Promise<UserId | undefined> {
    return Promise.resolve(this.resolveResult as UserId | undefined)
  }
  protected mutateCredentialRecord(_mutation: UserCredentialMutation): Promise<UserCredentialMutationCommit> {
    return Promise.resolve(this.mutationResult as UserCredentialMutationCommit)
  }
  protected verifyPasswordSecret(_userId: UserId, _password: string): Promise<boolean> {
    return Promise.resolve(this.verifyResult as boolean)
  }
}

describe('user credential validation', () => {
  it('rejects malformed identifiers, passwords, revisions, ids, and contexts', async () => {
    const { credentials } = await setup(MemoryUserCredentialService)
    await expect(credentials.normalize({ kind: 'Email', value: 'x' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.normalize({ kind: 'email', value: '' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.normalize({ kind: 'email', value: 'x'.repeat(MAX_LOGIN_IDENTIFIER_BYTES + 1) })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.setPassword({ userId: id('bad id'), expectedRevision: 0, password: 'x' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: -1, password: 'x' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: 0, password: '' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: 0, password: '密'.repeat(MAX_PASSWORD_BYTES) })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.addIdentifier({ userId: id('user-1'), expectedRevision: 0, kind: 'email', value: 'a@b.c', context: { correlationId: '' } })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.addIdentifier({ userId: id('user-1'), expectedRevision: 0, kind: 'email', value: 'a@b.c', context: { reason: ' ' } })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(credentials.addIdentifier({ userId: id('user-1'), expectedRevision: 0, kind: 'email', value: 'a@b.c', context: { actorUserId: id('bad id') } })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('normalizes unexpected Provider failures and invalid scalar results', async () => {
    const { credentials } = await setup(BrokenCredentialService)
    credentials.failure = new Error('database password')
    await expect(credentials.normalize({ kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })
    credentials.failure = new UserCredentialError('identifier-conflict', 'known')
    await expect(credentials.normalize({ kind: 'email', value: 'x@y.z' })).rejects.toBe(credentials.failure)
    credentials.failure = undefined
    credentials.normalizeResult = ''
    await expect(credentials.normalize({ kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })
    credentials.normalizeResult = 'x@y.z'
    credentials.resolveResult = id('bad id')
    await expect(credentials.resolve({ kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })
    credentials.verifyResult = 'yes'
    await expect(credentials.verifyPassword({ userId: id('user-1'), password: 'x' })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects malformed Provider records and commits', async () => {
    const { credentials } = await setup(BrokenCredentialService)
    credentials.readResult = { userId: 'user-1' }
    await expect(credentials.get(id('user-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
    credentials.readResult = { userId: 'user-1', revision: 1, updatedAt: 1, passwordEnabled: false, identifiers: [{ kind: 'Bad', value: 'x', createdAt: 1 }] }
    await expect(credentials.get(id('user-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
    credentials.mutationResult = undefined
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: 0, password: 'x' })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects unsafe Provider metadata variants', async () => {
    const { credentials } = await setup(BrokenCredentialService)
    const malformed: unknown[] = [
      record({ identifiers: [null as never] }),
      record({ identifiers: [{ kind: 'email', value: '', createdAt: 1 }] }),
      record({ identifiers: [
        { kind: 'email', value: 'x@y.z', createdAt: 1 },
        { kind: 'email', value: 'x@y.z', createdAt: 2 },
      ] }),
      record({ passwordEnabled: true }),
      record({ passwordEnabled: false, passwordChangedAt: 1 }),
    ]
    for (const value of malformed) {
      credentials.readResult = value
      await expect(credentials.get(id('user-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
    }
    credentials.readResult = record({ passwordEnabled: true, passwordChangedAt: 1 })
    await expect(credentials.get(id('user-1'))).resolves.toMatchObject({ passwordEnabled: true })
  })

  it('rejects inconsistent Provider mutation proofs', async () => {
    const { credentials } = await setup(BrokenCredentialService)
    credentials.mutationResult = { current: record({ revision: 2 }) }
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: 0, password: 'x' })).rejects.toMatchObject({ code: 'provider-unavailable' })

    credentials.mutationResult = { current: record() }
    await expect(credentials.addIdentifier({ userId: id('user-1'), expectedRevision: 0, kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })

    const previous = record({ identifiers: [{ kind: 'email', value: 'x@y.z', createdAt: 1 }] })
    credentials.mutationResult = { previous, current: record({ revision: 2, identifiers: previous.identifiers }) }
    await expect(credentials.removeIdentifier({ userId: id('user-1'), expectedRevision: 1, kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })

    credentials.mutationResult = {
      previous: record(),
      current: record({ revision: 2, identifiers: [{ kind: 'email', value: 'x@y.z', createdAt: 2 }], passwordEnabled: true, passwordChangedAt: 2, updatedAt: 2 }),
    }
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: 1, password: 'x' })).rejects.toMatchObject({ code: 'provider-unavailable' })

    credentials.mutationResult = { previous: record(), current: record({ revision: 2 }) }
    await expect(credentials.disablePassword({ userId: id('user-1'), expectedRevision: 1 })).rejects.toMatchObject({ code: 'provider-unavailable' })

    credentials.mutationResult = {
      previous: record(),
      current: record({ revision: 2, updatedAt: 2, passwordEnabled: true, passwordChangedAt: 1 }),
    }
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: 1, password: 'x' })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('contains synchronous and asynchronous listener failures after commit', async () => {
    const { ctx, credentials } = await setup(MemoryUserCredentialService)
    ctx.on('user-credential/changed', () => { throw new Error('sync listener') })
    // oxlint-disable-next-line typescript/no-misused-promises -- exercises rejected-listener containment
    ctx.on('user-credential/changed', () => Promise.reject(new Error('async listener')))
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: 0, password: 'x' })).resolves.toMatchObject({ revision: 1 })
    await Promise.resolve()
  })

  it('rethrows invariant listener failures after the Provider commits', async () => {
    const { ctx, credentials } = await setup(MemoryUserCredentialService)
    const failure = Object.assign(new Error('invariant'), { code: 'INVARIANT' })
    ctx.on('user-credential/changed', () => { throw failure })
    await expect(credentials.setPassword({ userId: id('user-1'), expectedRevision: 0, password: 'x' })).rejects.toBe(failure)
    expect(await credentials.verifyPassword({ userId: id('user-1'), password: 'x' })).toBe(true)
  })
})
