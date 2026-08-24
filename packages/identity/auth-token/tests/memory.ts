import {
  AuthTokenError,
  AuthTokenService,
  type AuthTokenInspectRequest,
  type CredentialId,
  type RefreshCredentialRecord,
  type RefreshTokenRotationInput,
  type RefreshTokenRotationCommit,
  type TokenFamilyCreateInput,
  type TokenFamilyId,
  type TokenFamilyRecord,
  type TokenRevocationCommit,
  type TokenRevocationInput,
} from '../src/index.ts'

/** In-memory Provider used to exercise the shared token-family contract. */
export class MemoryAuthTokens extends AuthTokenService {
  private readonly families = new Map<TokenFamilyId, TokenFamilyRecord>()
  private readonly credentials = new Map<CredentialId, RefreshCredentialRecord>()
  private sequence = 0
  private clock = 1_000

  /** Move the deterministic Provider clock to one exact time. */
  setTime(value: number): void {
    this.clock = value
  }

  protected createFamilyRecord(input: TokenFamilyCreateInput): Promise<TokenFamilyCreateInput> {
    this.families.set(input.family.tokenFamilyId, input.family)
    this.credentials.set(input.credential.credentialId, input.credential)
    return Promise.resolve(input)
  }

  protected rotateFamilyRecord(input: RefreshTokenRotationInput): Promise<RefreshTokenRotationCommit> {
    const credential = [...this.credentials.values()].find(value => value.digest === input.digest)
    if (credential === undefined) throw new AuthTokenError('refresh-token-invalid', 'memory token was not found')
    const family = this.families.get(credential.tokenFamilyId)!
    if (family.status === 'revoked') throw new AuthTokenError('token-family-revoked', 'memory family is revoked')
    if (input.time >= credential.expiresAt || input.time >= family.expiresAt) {
      throw new AuthTokenError('refresh-token-expired', 'memory token is expired')
    }
    if (credential.status === 'rotated') {
      const current: TokenFamilyRecord = {
        ...family,
        status: 'revoked',
        updatedAt: input.time,
        revision: family.revision + 1,
        revokedAt: input.time,
        revocationReason: 'refresh-token-reuse',
      }
      this.families.set(current.tokenFamilyId, current)
      this.revokeActiveCredentials(current.tokenFamilyId, input.time)
      return Promise.resolve({ kind: 'reused', previousFamily: family, currentFamily: current, reusedCredential: credential })
    }
    if (credential.status !== 'active') throw new AuthTokenError('token-family-revoked', 'memory credential is revoked')
    if (input.expiresAt > family.expiresAt) throw new AuthTokenError('invalid-input', 'memory replacement exceeds family expiry')
    const consumedCredential: RefreshCredentialRecord = {
      ...credential,
      status: 'rotated',
      rotatedAt: input.time,
      replacedBy: input.replacementCredentialId,
    }
    const replacementCredential: RefreshCredentialRecord = {
      credentialId: input.replacementCredentialId,
      tokenFamilyId: family.tokenFamilyId,
      digest: input.replacementDigest,
      status: 'active',
      issuedAt: input.time,
      expiresAt: input.expiresAt,
    }
    const currentFamily: TokenFamilyRecord = { ...family, updatedAt: input.time, revision: family.revision + 1 }
    this.credentials.set(consumedCredential.credentialId, consumedCredential)
    this.credentials.set(replacementCredential.credentialId, replacementCredential)
    this.families.set(currentFamily.tokenFamilyId, currentFamily)
    return Promise.resolve({
      kind: 'rotated',
      previousFamily: family,
      currentFamily,
      consumedCredential,
      replacementCredential,
    })
  }

  protected inspectRecords(target: AuthTokenInspectRequest['target']): Promise<Readonly<{
    families: readonly TokenFamilyRecord[]
    credentials: readonly RefreshCredentialRecord[]
  }>> {
    let families: TokenFamilyRecord[]
    if (target.kind === 'credential') {
      const credential = this.credentials.get(target.credentialId)
      const family = credential === undefined ? undefined : this.families.get(credential.tokenFamilyId)
      families = family === undefined ? [] : [family]
    } else if (target.kind === 'token-family') {
      const family = this.families.get(target.tokenFamilyId)
      families = family === undefined ? [] : [family]
    } else {
      families = [...this.families.values()].filter(value => this.samePrincipal(value.principal, target.principal))
    }
    const ids = new Set(families.map(value => value.tokenFamilyId))
    return Promise.resolve({
      families,
      credentials: [...this.credentials.values()].filter(value => ids.has(value.tokenFamilyId)),
    })
  }

  protected revokeRecords(input: TokenRevocationInput): Promise<TokenRevocationCommit> {
    const targetCredentialId = input.target.kind === 'credential' ? input.target.credentialId : undefined
    return this.inspectRecords(input.target).then(({ families, credentials }) => {
      const commits = families.map((family) => {
        if (family.status === 'revoked') return { previous: family, current: family }
        const current: TokenFamilyRecord = {
          ...family,
          status: 'revoked',
          updatedAt: input.time,
          revision: family.revision + 1,
          revokedAt: input.time,
          revocationReason: input.reason,
        }
        this.families.set(current.tokenFamilyId, current)
        this.revokeActiveCredentials(current.tokenFamilyId, input.time)
        return { previous: family, current }
      })
      const matched = targetCredentialId === undefined
        ? undefined
        : credentials.find(value => value.credentialId === targetCredentialId)
      return {
        families: commits,
        ...(matched === undefined ? {} : { matchedCredential: matched }),
      }
    })
  }

  protected override now(): number {
    return this.clock
  }

  protected override generateId(kind: 'family' | 'refresh'): string {
    this.sequence += 1
    return `${kind}-${String(this.sequence)}`
  }

  protected override generateRefreshSecret(): string {
    this.sequence += 1
    return `dsh_rt_secret-${String(this.sequence)}`
  }

  private revokeActiveCredentials(familyId: TokenFamilyId, time: number): void {
    for (const credential of this.credentials.values()) {
      if (credential.tokenFamilyId === familyId && credential.status === 'active') {
        this.credentials.set(credential.credentialId, { ...credential, status: 'revoked', revokedAt: time })
      }
    }
  }

  private samePrincipal(left: TokenFamilyRecord['principal'], right: TokenFamilyRecord['principal']): boolean {
    return left.kind === right.kind && left.id === right.id
  }
}
