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
import { runUserCredentialContract } from '../src/testing.ts'
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

async function credentialFailure(operation: Promise<unknown>): Promise<UserCredentialError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(UserCredentialError)
    return error as UserCredentialError
  }
  throw new Error('expected credential operation to reject')
}

runUserCredentialContract(
  { suite: describe, test: it },
  'memory',
  async () => {
    const harness = await setup(MemoryUserCredentialService)
    return {
      ...harness,
      readPasswordVerificationCount: () => harness.credentials.readPasswordVerificationCount(),
    }
  },
)

class BrokenCredentialService extends UserCredentialService {
  normalizeResult: unknown = 'normalized'
  readResult: unknown
  resolveResult: unknown
  mutationResult: unknown
  verifyResult: unknown = false
  failure: Error | undefined
  readFailure: Error | undefined
  resolveFailure: Error | undefined
  mutationFailure: Error | undefined
  verificationFailure: Error | undefined

  protected normalizeLoginIdentifier(_input: LoginIdentifierInput): Promise<string> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(this.normalizeResult as string)
  }
  protected readCredentialRecord(_userId: UserId): Promise<UserCredentialRecord | undefined> {
    if (this.readFailure !== undefined) return Promise.reject(this.readFailure)
    return Promise.resolve(this.readResult as UserCredentialRecord | undefined)
  }
  protected resolveLoginIdentifier(_identifier: LoginIdentifier): Promise<UserId | undefined> {
    if (this.resolveFailure !== undefined) return Promise.reject(this.resolveFailure)
    return Promise.resolve(this.resolveResult as UserId | undefined)
  }
  protected mutateCredentialRecord(_mutation: UserCredentialMutation): Promise<UserCredentialMutationCommit> {
    if (this.mutationFailure !== undefined) return Promise.reject(this.mutationFailure)
    return Promise.resolve(this.mutationResult as UserCredentialMutationCommit)
  }
  protected verifyPasswordSecret(_userId: UserId | undefined, _password: string): Promise<boolean> {
    if (this.verificationFailure !== undefined) return Promise.reject(this.verificationFailure)
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
    await expect(credentials.normalize({ kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })
    credentials.failure = undefined
    credentials.normalizeResult = ''
    await expect(credentials.normalize({ kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })
    credentials.normalizeResult = 'x@y.z'
    credentials.resolveResult = id('bad id')
    await expect(credentials.resolve({ kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })
    credentials.verifyResult = 'yes'
    await expect(credentials.verifyPassword({ userId: id('user-1'), password: 'x' })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rebuilds Provider failures without messages, causes, or secrets', async () => {
    const { credentials } = await setup(BrokenCredentialService)
    const secret = 'database-password=super-secret'
    credentials.failure = new UserCredentialError('invalid-input', secret, { cause: new Error(secret) })
    const normalized = await credentialFailure(credentials.normalize({ kind: 'email', value: 'x@y.z' }))
    expect(normalized).toMatchObject({ code: 'invalid-input' })
    expect(normalized.message).toBe('user-credential: Provider rejected the credential input')
    expect(normalized.message).not.toContain(secret)
    expect(normalized.cause).toBeUndefined()
    expect(normalized).not.toBe(credentials.failure)

    credentials.failure = undefined
    credentials.readFailure = new UserCredentialError('credential-not-found', secret, { cause: new Error(secret) })
    const read = await credentialFailure(credentials.get(id('user-1')))
    expect(read).toMatchObject({ code: 'provider-unavailable' })
    expect(read.message).not.toContain(secret)
    expect(read.cause).toBeUndefined()

    credentials.readFailure = undefined
    credentials.resolveFailure = new Error(secret)
    const resolved = await credentialFailure(credentials.resolve({ kind: 'email', value: 'x@y.z' }))
    expect(resolved).toMatchObject({ code: 'provider-unavailable' })
    expect(resolved.message).not.toContain(secret)
    expect(resolved.cause).toBeUndefined()

    credentials.resolveFailure = undefined
    credentials.mutationFailure = new UserCredentialError('identifier-conflict', secret, { cause: new Error(secret) })
    const allowed = await credentialFailure(credentials.addIdentifier({
      userId: id('user-1'), expectedRevision: 0, kind: 'email', value: 'x@y.z',
    }))
    expect(allowed).toMatchObject({ code: 'identifier-conflict' })
    expect(allowed.message).toBe('user-credential: login identifier is already assigned')
    expect(allowed.cause).toBeUndefined()

    credentials.mutationFailure = new UserCredentialError('invalid-credential', secret)
    const disallowed = await credentialFailure(credentials.addIdentifier({
      userId: id('user-1'), expectedRevision: 0, kind: 'email', value: 'x@y.z',
    }))
    expect(disallowed).toMatchObject({ code: 'provider-unavailable' })
    expect(disallowed.message).not.toContain(secret)
  })

  it('collapses expected verification failures to false and sanitizes unexpected failures', async () => {
    const { credentials } = await setup(BrokenCredentialService)
    for (const code of ['credential-not-found', 'password-not-set', 'invalid-credential'] as const) {
      credentials.verificationFailure = new UserCredentialError(code, `secret-${code}`, { cause: new Error('secret') })
      await expect(credentials.verifyPassword({ password: 'candidate' })).resolves.toBe(false)
    }
    credentials.verificationFailure = new UserCredentialError('revision-conflict', 'secret-revision')
    const failure = await credentialFailure(credentials.verifyPassword({ password: 'candidate' }))
    expect(failure).toMatchObject({ code: 'provider-unavailable' })
    expect(failure.message).toBe('user-credential: credential Provider failed')
    expect(failure.cause).toBeUndefined()
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

    credentials.mutationResult = {
      previous: record({ identifiers: [{ kind: 'username', value: 'before', createdAt: 1 }] }),
      current: record({ revision: 2, identifiers: [{ kind: 'email', value: 'x@y.z', createdAt: 2 }, { kind: 'username', value: 'replaced', createdAt: 1 }] }),
    }
    await expect(credentials.addIdentifier({ userId: id('user-1'), expectedRevision: 1, kind: 'email', value: 'x@y.z' })).rejects.toMatchObject({ code: 'provider-unavailable' })

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

    credentials.mutationResult = {
      previous: record({ passwordEnabled: false }),
      current: record({ revision: 2, updatedAt: 2, passwordEnabled: true, passwordChangedAt: 2 }),
    }
    await expect(credentials.changePassword({
      userId: id('user-1'), expectedRevision: 1, currentPassword: 'old', newPassword: 'new',
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
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
