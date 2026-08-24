import { Context } from '@deepseek-ai/cordis'
import {
  authenticationRequestId,
  credentialId,
  localPrincipalId,
  serviceAccountId,
  tokenFamilyId,
  userId,
} from '@deepseek-ai/dsh-auth'
import { describe, expect, it, vi } from 'vitest'
import AuthTokenService, {
  type AuthTokenInspectRequest,
  type CredentialInspectTarget,
  type RefreshCredentialRecord,
  type RefreshTokenRotationCommit,
  type RefreshTokenRotationInput,
  type TokenFamilyCreateInput,
  type TokenFamilyRecord,
  type TokenRevocationCommit,
  type TokenRevocationInput,
} from '../src/index.ts'
import { MemoryAuthTokens } from './memory.ts'

const requestId = authenticationRequestId('request-1')
const signal = new AbortController().signal
const principal = { kind: 'user' as const, id: userId('user-1') }
const target: CredentialInspectTarget = { kind: 'token-family', tokenFamilyId: tokenFamilyId('family-1') }
const digest = 'a'.repeat(64) as RefreshCredentialRecord['digest']

function family(overrides: Partial<TokenFamilyRecord> = {}): TokenFamilyRecord {
  return {
    tokenFamilyId: tokenFamilyId('family-1'),
    principal,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 100,
    revision: 1,
    ...overrides,
  }
}

function credential(overrides: Partial<RefreshCredentialRecord> = {}): RefreshCredentialRecord {
  return {
    credentialId: credentialId('refresh-1'),
    tokenFamilyId: tokenFamilyId('family-1'),
    digest,
    status: 'active',
    issuedAt: 1,
    expiresAt: 100,
    ...overrides,
  }
}

class BrokenAuthTokens extends AuthTokenService {
  createTransform: (input: TokenFamilyCreateInput) => unknown = input => input
  rotationResult: unknown = undefined
  inspectionResult: unknown = { families: [], credentials: [] }
  revocationResult: unknown = { families: [] }
  failure: Error | undefined
  fixedTime: number | undefined

  protected override now(): number {
    return this.fixedTime ?? super.now()
  }

  protected async createFamilyRecord(
    input: TokenFamilyCreateInput,
    prepare: () => Promise<void>,
  ): Promise<TokenFamilyCreateInput> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    await prepare()
    return this.createTransform(input) as TokenFamilyCreateInput
  }

  protected async rotateFamilyRecord(
    _input: RefreshTokenRotationInput,
    prepare: (candidate: RefreshTokenRotationCommit) => Promise<void>,
  ): Promise<RefreshTokenRotationCommit> {
    const result = this.rotationResult as RefreshTokenRotationCommit
    if (result.kind === 'rotated') await prepare(result)
    return result
  }

  protected inspectRecords(_target: AuthTokenInspectRequest['target']): Promise<Readonly<{
    families: readonly TokenFamilyRecord[]
    credentials: readonly RefreshCredentialRecord[]
  }>> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(this.inspectionResult as never)
  }

  protected revokeRecords(_input: TokenRevocationInput): Promise<TokenRevocationCommit> {
    return Promise.resolve(this.revocationResult as TokenRevocationCommit)
  }
}

class CorruptMemoryAuthTokens extends MemoryAuthTokens {
  corruptRotation = false
  corruptReuse = false
  expireRotationFamily = false
  expireRotationCredential = false
  alterReplacementExpiry = false
  expireReuseFamily = false
  expireReuseCredential = false
  corruptRevocation = false
  duplicateRevocation = false

  protected override async rotateFamilyRecord(
    input: RefreshTokenRotationInput,
    prepare: (candidate: RefreshTokenRotationCommit) => Promise<void>,
  ): Promise<RefreshTokenRotationCommit> {
    const commit = await super.rotateFamilyRecord(input, prepare)
    if (commit.kind === 'rotated' && this.expireRotationFamily) {
      return {
        ...commit,
        previousFamily: { ...commit.previousFamily, expiresAt: input.time },
        currentFamily: { ...commit.currentFamily, expiresAt: input.time },
      }
    }
    if (commit.kind === 'rotated' && this.expireRotationCredential) {
      return { ...commit, consumedCredential: { ...commit.consumedCredential, expiresAt: input.time } }
    }
    if (commit.kind === 'rotated' && this.alterReplacementExpiry) {
      return {
        ...commit,
        replacementCredential: {
          ...commit.replacementCredential,
          expiresAt: commit.replacementCredential.expiresAt - 1,
        },
      }
    }
    if (commit.kind === 'reused' && this.expireReuseFamily) {
      return {
        ...commit,
        previousFamily: { ...commit.previousFamily, expiresAt: input.time },
        currentFamily: { ...commit.currentFamily, expiresAt: input.time },
      }
    }
    if (commit.kind === 'reused' && this.expireReuseCredential) {
      return { ...commit, reusedCredential: { ...commit.reusedCredential, expiresAt: input.time } }
    }
    if (commit.kind === 'rotated' && this.corruptRotation) {
      return { ...commit, currentFamily: { ...commit.currentFamily, revision: commit.currentFamily.revision + 1 } }
    }
    if (commit.kind === 'reused' && this.corruptReuse) {
      return { ...commit, currentFamily: { ...commit.currentFamily, revision: commit.currentFamily.revision + 1 } }
    }
    return commit
  }

  protected override async revokeRecords(input: TokenRevocationInput): Promise<TokenRevocationCommit> {
    const commit = await super.revokeRecords(input)
    if (this.corruptRevocation && commit.families[0] !== undefined) {
      const [first, ...rest] = commit.families
      return {
        families: [{ ...first, current: { ...first.current, revision: first.current.revision + 1 } }, ...rest],
      }
    }
    if (this.duplicateRevocation && commit.families[0] !== undefined) {
      return { families: [...commit.families, commit.families[0]] }
    }
    return commit
  }
}

class PreparationViolationAuthTokens extends MemoryAuthTokens {
  issueMode: 'normal' | 'skip' | 'double' = 'normal'
  rotateMode: 'normal' | 'skip' | 'double' | 'non-rotation' | 'mismatch' = 'normal'

  protected override createFamilyRecord(
    input: TokenFamilyCreateInput,
    prepare: () => Promise<void>,
  ): Promise<TokenFamilyCreateInput> {
    if (this.issueMode === 'skip') return super.createFamilyRecord(input, async () => undefined)
    if (this.issueMode === 'double') {
      return super.createFamilyRecord(input, async () => {
        await prepare()
        await prepare()
      })
    }
    return super.createFamilyRecord(input, prepare)
  }

  protected override async rotateFamilyRecord(
    input: RefreshTokenRotationInput,
    prepare: (candidate: RefreshTokenRotationCommit) => Promise<void>,
  ): Promise<RefreshTokenRotationCommit> {
    if (this.rotateMode === 'non-rotation') {
      await prepare({ kind: 'reused' } as RefreshTokenRotationCommit)
    }
    const callback = this.rotateMode === 'skip'
      ? async (): Promise<void> => undefined
      : this.rotateMode === 'double'
        ? async (candidate: RefreshTokenRotationCommit): Promise<void> => {
          await prepare(candidate)
          await prepare(candidate)
        }
        : prepare
    const commit = await super.rotateFamilyRecord(input, callback)
    if (this.rotateMode !== 'mismatch' || commit.kind !== 'rotated') return commit
    const otherPrincipal = { kind: 'user' as const, id: userId('user-other') }
    return {
      ...commit,
      previousFamily: { ...commit.previousFamily, principal: otherPrincipal },
      currentFamily: { ...commit.currentFamily, principal: otherPrincipal },
    }
  }
}

async function broken(): Promise<BrokenAuthTokens> {
  const ctx = new Context()
  await ctx.plugin(BrokenAuthTokens)
  return ctx.authTokens as BrokenAuthTokens
}

function revokedCommit(record: TokenFamilyRecord, time: number): TokenRevocationCommit['families'][number] {
  return {
    previous: record,
    current: {
      ...record,
      status: 'revoked',
      updatedAt: time,
      revision: record.revision + 1,
      revokedAt: time,
      revocationReason: 'requested',
    },
  }
}

async function memory<T extends MemoryAuthTokens>(Provider: new (ctx: Context) => T): Promise<T> {
  const ctx = new Context()
  await ctx.plugin(Provider)
  return ctx.authTokens as T
}

async function expectInspectionFailure(families: unknown[], credentials: unknown[] = []): Promise<void> {
  const service = await broken()
  service.inspectionResult = { families, credentials }
  await expect(service.inspect({ requestId, signal, target })).rejects.toMatchObject({ code: 'provider-unavailable' })
}

describe('auth-token Provider validation', () => {
  it('uses secure base generators and rejects unexpected Provider failures', async () => {
    const service = await broken()
    const issued = await service.issueFamily({
      requestId,
      signal,
      principal,
      expiresAt: Date.now() + 60_000,
    })
    expect(issued.family.tokenFamilyId).toMatch(/^family-/)
    expect(issued.refreshToken.credentialId).toMatch(/^refresh-/)
    expect(issued.refreshToken.value).toMatch(/^dsh_rt_[A-Za-z0-9_-]{43}$/)
    service.failure = new Error('database password')
    await expect(service.inspect({ requestId, signal, target })).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'auth-token: lifecycle Provider failed',
    })
  })

  it.each(['skip', 'double'] as const)('rejects issue Provider preparation violation %s', async (mode) => {
    const service = await memory(PreparationViolationAuthTokens)
    service.issueMode = mode
    await expect(service.issueFamily({ requestId, signal, principal, expiresAt: 2_000 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each(['skip', 'double', 'non-rotation', 'mismatch'] as const)(
    'rejects rotation Provider preparation violation %s',
    async (mode) => {
      const service = await memory(PreparationViolationAuthTokens)
      const issued = await service.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
      service.setTime(1_100)
      service.rotateMode = mode
      await expect(service.rotate({ requestId, signal, refreshToken: issued.refreshToken.value }))
        .rejects.toMatchObject({ code: 'provider-unavailable' })
    },
  )

  it('accepts every principal kind and rejects malformed principal input', async () => {
    const service = await memory(MemoryAuthTokens)
    await expect(service.issueFamily({
      requestId,
      signal,
      principal: { kind: 'service-account', id: serviceAccountId('service-1') },
      expiresAt: 2_000,
    })).resolves.toMatchObject({ family: { principal: { kind: 'service-account' } } })
    await expect(service.issueFamily({
      requestId,
      signal,
      principal: { kind: 'local', id: localPrincipalId('local-1') },
      expiresAt: 2_000,
    })).resolves.toMatchObject({ family: { principal: { kind: 'local' } } })
    await expect(service.issueFamily({
      requestId,
      signal,
      principal: { kind: 'user', id: 'bad id' as never },
      expiresAt: 2_000,
    })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it.each([
    null,
    {},
    family({ tokenFamilyId: 'bad id' as never }),
    family({ status: 'invalid' as never }),
    family({ revision: 0 }),
    family({ principal: null as never }),
    family({ principal: { kind: 'user', id: 1 } as never }),
    family({ principal: { kind: 'invalid', id: 'x' } as never }),
    family({ principal: { kind: 'user', id: 'bad id' } as never }),
    family({ createdAt: -1 }),
    family({ updatedAt: 0, createdAt: 1 }),
    family({ expiresAt: 1 }),
    family({ revokedAt: 2 }),
    family({ revocationReason: 'requested' }),
    family({ status: 'revoked' }),
    family({ status: 'revoked', revokedAt: 0, revocationReason: 'requested' }),
    family({ status: 'revoked', revokedAt: 2, revocationReason: 'invalid' as never }),
  ])('rejects malformed family record %#', async (record) => {
    await expectInspectionFailure([record])
  })

  it('accepts both revoked family reasons', async () => {
    const service = await broken()
    service.inspectionResult = {
      families: [
        family({ status: 'revoked', updatedAt: 2, revokedAt: 2, revocationReason: 'requested' }),
        family({
          tokenFamilyId: tokenFamilyId('family-2'),
          status: 'revoked',
          updatedAt: 2,
          revokedAt: 2,
          revocationReason: 'refresh-token-reuse',
        }),
      ],
      credentials: [],
    }
    await expect(service.inspect({
      requestId,
      signal,
      target: { kind: 'principal', principal },
    })).resolves.toHaveProperty('families.length', 2)
  })

  it.each([
    null,
    {},
    credential({ credentialId: 'bad id' as never }),
    credential({ tokenFamilyId: 'bad id' as never }),
    credential({ digest: 'short' as never }),
    credential({ status: 'invalid' as never }),
    credential({ issuedAt: -1 }),
    credential({ expiresAt: 1 }),
    credential({ rotatedAt: 2 }),
    credential({ replacedBy: credentialId('refresh-2') }),
    credential({ revokedAt: 2 }),
    credential({ status: 'rotated' }),
    credential({ status: 'rotated', rotatedAt: 0, replacedBy: credentialId('refresh-2') }),
    credential({ status: 'rotated', rotatedAt: 2, replacedBy: 'bad id' as never }),
    credential({ status: 'rotated', rotatedAt: 2, replacedBy: credentialId('refresh-2'), revokedAt: 2 }),
    credential({ status: 'revoked' }),
    credential({ status: 'revoked', revokedAt: 0 }),
    credential({ status: 'revoked', revokedAt: 2, rotatedAt: 2 }),
    credential({ status: 'revoked', revokedAt: 2, replacedBy: credentialId('refresh-2') }),
  ])('rejects malformed refresh credential %#', async (record) => {
    await expectInspectionFailure([family()], [record])
  })

  it('accepts complete rotated and revoked credential metadata', async () => {
    const service = await broken()
    service.inspectionResult = {
      families: [family()],
      credentials: [
        credential({ status: 'rotated', rotatedAt: 2, replacedBy: credentialId('refresh-2') }),
        credential({ credentialId: credentialId('refresh-2'), status: 'revoked', revokedAt: 3 }),
      ],
    }
    const result = await service.inspect({ requestId, signal, target })
    expect(result.credentials).toEqual([
      expect.objectContaining({ status: 'rotated', rotatedAt: 2, replacedBy: 'refresh-2' }),
      expect.objectContaining({ status: 'revoked', revokedAt: 3 }),
    ])
  })

  it.each([
    { families: [family(), family()], credentials: [] },
    { families: [family()], credentials: [credential(), credential()] },
    { families: [family()], credentials: [credential({ tokenFamilyId: tokenFamilyId('family-2') })] },
  ])('rejects inconsistent inspection %#', async (result) => {
    const service = await broken()
    service.inspectionResult = result
    await expect(service.inspect({ requestId, signal, target })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    {
      target: { kind: 'token-family' as const, tokenFamilyId: tokenFamilyId('family-1') },
      families: [family({ tokenFamilyId: tokenFamilyId('family-2') })],
      credentials: [],
    },
    {
      target: { kind: 'principal' as const, principal },
      families: [family({ principal: { kind: 'user', id: userId('user-2') } })],
      credentials: [],
    },
    {
      target: { kind: 'credential' as const, credentialId: credentialId('refresh-2') },
      families: [family()],
      credentials: [credential()],
    },
  ])('binds inspection result to request target %#', async ({ target: requestTarget, families, credentials }) => {
    const service = await broken()
    service.inspectionResult = { families, credentials }
    await expect(service.inspect({ requestId, signal, target: requestTarget }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects inconsistent initial commits and invalid operation carriers', async () => {
    const service = await broken()
    service.createTransform = input => ({ ...input, family: { ...input.family, revision: 2 } })
    await expect(service.issueFamily({ requestId, signal, principal, expiresAt: Date.now() + 60_000 }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
    await expect(service.inspect({ requestId: 'bad id' as never, signal, target }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(service.inspect({ requestId, signal: null as never, target }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(service.issueFamily({ requestId, signal, principal, expiresAt: Number.NaN }))
      .rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('contains every post-commit listener failure after fan-out', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryAuthTokens)
    const service = ctx.authTokens as MemoryAuthTokens
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const observed = vi.fn()
    const rejected = (() => Promise.reject(new Error('async'))) as unknown as () => void
    const nullListener = (() => null) as unknown as () => void
    ctx.on('auth-token/changed', rejected)
    ctx.on('auth-token/changed', nullListener)
    await service.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
    ctx.on('auth-token/changed', () => { throw Object.assign(new Error('invariant'), { code: 'INVARIANT' }) })
    ctx.on('auth-token/changed', observed)
    await expect(service.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })).resolves.toHaveProperty('refreshToken.value')
    expect(observed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'invariant' }))
  })

  it.each([
    {
      target: { kind: 'token-family' as const, tokenFamilyId: tokenFamilyId('family-1') },
      commit: { families: [revokedCommit(family({ tokenFamilyId: tokenFamilyId('family-2') }), 10)] },
    },
    {
      target: { kind: 'principal' as const, principal },
      commit: {
        families: [revokedCommit(family({ principal: { kind: 'user', id: userId('user-2') } }), 10)],
      },
    },
    {
      target: { kind: 'credential' as const, credentialId: credentialId('refresh-1') },
      commit: { families: [revokedCommit(family(), 10)] },
    },
    {
      target: { kind: 'credential' as const, credentialId: credentialId('refresh-1') },
      commit: { families: [], matchedCredential: credential() },
    },
    {
      target: { kind: 'credential' as const, credentialId: credentialId('refresh-2') },
      commit: { families: [revokedCommit(family(), 10)], matchedCredential: credential() },
    },
    {
      target: { kind: 'credential' as const, credentialId: credentialId('refresh-1') },
      commit: {
        families: [revokedCommit(family(), 10)],
        matchedCredential: credential({ tokenFamilyId: tokenFamilyId('family-2') }),
      },
    },
  ])('binds revocation commit to request target before emitting %#', async ({ target: requestTarget, commit }) => {
    const ctx = new Context()
    await ctx.plugin(BrokenAuthTokens)
    const service = ctx.authTokens as BrokenAuthTokens
    const observed = vi.fn()
    ctx.on('auth-token/changed', observed)
    service.fixedTime = 10
    service.revocationResult = commit
    await expect(service.revoke({ requestId, signal, target: requestTarget }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
    expect(observed).not.toHaveBeenCalled()
  })

  it('accepts an empty credential-target revocation result without an orphan proof', async () => {
    const service = await broken()
    service.fixedTime = 10
    service.revocationResult = { families: [] }
    await expect(service.revoke({
      requestId,
      signal,
      target: { kind: 'credential', credentialId: credentialId('refresh-missing') },
    })).resolves.toBeUndefined()
  })

  it.each([
    'expireRotationFamily',
    'expireRotationCredential',
    'alterReplacementExpiry',
  ] as const)('rejects expired rotation commit field %s', async (flag) => {
    const service = await memory(CorruptMemoryAuthTokens)
    const issued = await service.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    service.setTime(1_100)
    service[flag] = true
    await expect(service.rotate({
      requestId,
      signal,
      refreshToken: issued.refreshToken.value,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    'expireReuseFamily',
    'expireReuseCredential',
  ] as const)('rejects expired reuse commit field %s', async (flag) => {
    const service = await memory(CorruptMemoryAuthTokens)
    const issued = await service.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    service.setTime(1_100)
    await service.rotate({ requestId, signal, refreshToken: issued.refreshToken.value })
    service.setTime(1_200)
    service[flag] = true
    await expect(service.rotate({
      requestId,
      signal,
      refreshToken: issued.refreshToken.value,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects inconsistent rotation, reuse, and revocation commits', async () => {
    const service = await memory(CorruptMemoryAuthTokens)
    const first = await service.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    service.setTime(1_100)
    service.corruptRotation = true
    await expect(service.rotate({
      requestId,
      signal,
      refreshToken: first.refreshToken.value,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    const reuseService = await memory(CorruptMemoryAuthTokens)
    const reusable = await reuseService.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    reuseService.setTime(1_100)
    await reuseService.rotate({ requestId, signal, refreshToken: reusable.refreshToken.value })
    reuseService.setTime(1_200)
    reuseService.corruptReuse = true
    await expect(reuseService.rotate({
      requestId,
      signal,
      refreshToken: reusable.refreshToken.value,
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    const revokeService = await memory(CorruptMemoryAuthTokens)
    const revocable = await revokeService.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    revokeService.setTime(1_100)
    revokeService.corruptRevocation = true
    await expect(revokeService.revoke({
      requestId,
      signal,
      target: { kind: 'token-family', tokenFamilyId: revocable.family.tokenFamilyId },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects duplicate Provider revocation commits', async () => {
    const service = await memory(CorruptMemoryAuthTokens)
    await service.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    service.setTime(1_100)
    service.duplicateRevocation = true
    await expect(service.revoke({ requestId, signal, target: { kind: 'principal', principal } }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })
})
