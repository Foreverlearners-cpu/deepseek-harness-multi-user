import UserCredentialService, {
  UserCredentialError,
  type LoginIdentifier,
  type LoginIdentifierInput,
  type UserCredentialMutation,
  type UserCredentialMutationCommit,
  type UserCredentialRecord,
  type UserId,
} from '../src/index.ts'

interface StoredCredential {
  record: UserCredentialRecord
  password?: string
}

/** In-memory Provider used only by the shared credential contract suite. */
export class MemoryUserCredentialService extends UserCredentialService {
  private readonly records = new Map<UserId, StoredCredential>()
  private clock = 1_000
  verificationWork = 0

  protected normalizeLoginIdentifier(input: LoginIdentifierInput): Promise<string> {
    const value = input.value.trim().toLowerCase()
    if (value.length === 0) throw new UserCredentialError('invalid-input', 'memory identifier is empty')
    return Promise.resolve(value)
  }

  protected readCredentialRecord(userId: UserId): Promise<UserCredentialRecord | undefined> {
    return Promise.resolve(this.records.get(userId)?.record)
  }

  protected resolveLoginIdentifier(identifier: LoginIdentifier): Promise<UserId | undefined> {
    for (const [userId, stored] of this.records) {
      if (stored.record.identifiers.some(item => item.kind === identifier.kind && item.value === identifier.value)) {
        return Promise.resolve(userId)
      }
    }
    return Promise.resolve(undefined)
  }

  protected mutateCredentialRecord(mutation: UserCredentialMutation): Promise<UserCredentialMutationCommit> {
    const stored = this.records.get(mutation.userId)
    const previous = stored?.record
    if ((previous?.revision ?? 0) !== mutation.expectedRevision) throw new UserCredentialError('revision-conflict', 'memory revision changed')
    const now = this.tick()
    let identifiers = previous?.identifiers ?? []
    let password = stored?.password
    let passwordEnabled = previous?.passwordEnabled ?? false
    let passwordChangedAt = previous?.passwordChangedAt

    if (mutation.kind === 'identifier-add') {
      for (const existing of this.records.values()) {
        if (existing.record.identifiers.some(item => item.kind === mutation.identifier.kind && item.value === mutation.identifier.value)) {
          throw new UserCredentialError('identifier-conflict', 'memory identifier exists')
        }
      }
      identifiers = [...identifiers, { ...mutation.identifier, createdAt: now }]
    } else if (mutation.kind === 'identifier-remove') {
      const filtered = identifiers.filter(item => item.kind !== mutation.identifier.kind || item.value !== mutation.identifier.value)
      if (filtered.length === identifiers.length) throw new UserCredentialError('identifier-not-found', 'memory identifier missing')
      identifiers = filtered
    } else if (mutation.kind === 'password-set') {
      password = mutation.password
      passwordEnabled = true
      passwordChangedAt = now
    } else if (mutation.kind === 'password-change') {
      if (!passwordEnabled || password === undefined) throw new UserCredentialError('password-not-set', 'memory password is disabled')
      if (password !== mutation.currentPassword) throw new UserCredentialError('invalid-credential', 'memory current password is invalid')
      password = mutation.newPassword
      passwordChangedAt = now
    } else {
      if (!passwordEnabled) throw new UserCredentialError('password-not-set', 'memory password is disabled')
      password = undefined
      passwordEnabled = false
      passwordChangedAt = undefined
    }

    const current: UserCredentialRecord = {
      userId: mutation.userId,
      revision: mutation.expectedRevision + 1,
      identifiers,
      passwordEnabled,
      updatedAt: now,
      ...(passwordChangedAt === undefined ? {} : { passwordChangedAt }),
    }
    this.records.set(mutation.userId, { record: current, ...(password === undefined ? {} : { password }) })
    return Promise.resolve({ ...(previous === undefined ? {} : { previous }), current })
  }

  protected verifyPasswordSecret(userId: UserId, password: string): Promise<boolean> {
    this.verificationWork += 1
    const stored = this.records.get(userId)
    return Promise.resolve(stored?.record.passwordEnabled === true && stored.password === password)
  }

  private tick(): number {
    this.clock += 1
    return this.clock
  }
}
