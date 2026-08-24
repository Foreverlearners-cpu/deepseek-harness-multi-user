import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  AuthenticationError,
  authenticationMethod,
  authenticationRequestId,
  type AuthenticationAttempt,
  type AuthenticationEventRecord,
  type AuthenticationProvider,
} from '@deepseek-ai/dsh-auth'
import UserCredentialService, {
  UserCredentialError,
  type LoginIdentifier,
  type LoginIdentifierInput,
  type UserCredentialMutation,
  type UserCredentialMutationCommit,
  type UserCredentialRecord,
  type UserId,
} from '@deepseek-ai/dsh-user-credential'
import { describe, expect, it } from 'vitest'
import * as PasswordAuthentication from '../src/index.ts'

const TARGET = 'user-1' as UserId

class TestCredentials extends UserCredentialService {
  verificationRequests: Array<{ userId?: UserId; password: string }> = []
  resolveFailure?: unknown
  verifyFailure?: unknown

  protected normalizeLoginIdentifier(input: LoginIdentifierInput): Promise<string> {
    const value = input.value.trim().toLowerCase()
    if (value.length === 0) throw new UserCredentialError('invalid-input', 'test identifier is empty')
    return Promise.resolve(value)
  }

  protected readCredentialRecord(_userId: UserId): Promise<UserCredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  protected resolveLoginIdentifier(identifier: LoginIdentifier): Promise<UserId | undefined> {
    if (this.resolveFailure !== undefined) throw this.resolveFailure
    return Promise.resolve(identifier.value === 'alice' ? TARGET : undefined)
  }

  protected mutateCredentialRecord(_mutation: UserCredentialMutation): Promise<UserCredentialMutationCommit> {
    throw new Error('not used')
  }

  protected verifyPasswordSecret(userId: UserId | undefined, password: string): Promise<boolean> {
    this.verificationRequests.push({ ...(userId === undefined ? {} : { userId }), password })
    if (this.verifyFailure !== undefined) throw this.verifyFailure
    return Promise.resolve(userId === TARGET && password === 'correct-password')
  }
}

function attempt(identifier: string, password: string): AuthenticationAttempt<'password'> {
  return {
    requestId: authenticationRequestId('request-1'),
    channel: 'http',
    evidence: {
      kind: 'password',
      identifier: { kind: 'username', value: identifier },
      password,
    },
    signal: new AbortController().signal,
  }
}

async function setup(): Promise<{
  ctx: Context
  credentials: TestCredentials
  plugin: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(TestCredentials)
  const credentials = ctx.userCredentials as TestCredentials
  const plugin = ctx.plugin(PasswordAuthentication)
  await plugin
  return { ctx, credentials, plugin }
}

describe('password authentication Provider', () => {
  it('resolves the identifier, verifies the password, and lets auth mint the current call', async () => {
    const { ctx, credentials } = await setup()

    const call = await ctx.auth.authenticate(attempt(' Alice ', 'correct-password'))

    expect(call).toMatchObject({
      principal: { kind: 'user', id: TARGET },
      method: 'password',
      channel: 'http',
    })
    expect(ctx.auth.assertCurrent(call)).toBe(call)
    expect(credentials.verificationRequests).toEqual([{
      userId: TARGET,
      password: 'correct-password',
    }])
  })

  it('performs dummy verification for an unknown identifier and returns one generic failure', async () => {
    const { ctx, credentials } = await setup()
    const records: AuthenticationEventRecord[] = []
    ctx.on('auth/result', (record) => { records.push(record) })

    await expect(ctx.auth.authenticate(attempt('unknown-sensitive-login', 'candidate-secret')))
      .rejects.toMatchObject({
        code: 'unauthenticated',
        message: 'auth-password: credentials were rejected',
      })

    expect(credentials.verificationRequests).toEqual([{ password: 'candidate-secret' }])
    expect(records).toMatchObject([{ outcome: 'failed', reason: 'unauthenticated' }])
    expect(JSON.stringify(records)).not.toContain('unknown-sensitive-login')
    expect(JSON.stringify(records)).not.toContain('candidate-secret')
  })

  it('uses the same public failure for a wrong password and malformed evidence', async () => {
    const { ctx } = await setup()

    await expect(ctx.auth.authenticate(attempt('alice', 'wrong-secret')))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.auth.authenticate(attempt(' ', 'wrong-secret')))
      .rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('redacts credential Provider diagnostics while preserving availability semantics', async () => {
    const { ctx, credentials } = await setup()
    credentials.resolveFailure = new UserCredentialError(
      'provider-unavailable',
      'SQL included alice and candidate-secret',
      { cause: new Error('database password') },
    )

    const error = await ctx.auth.authenticate(attempt('alice', 'candidate-secret')).catch(
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(AuthenticationError)
    expect(error).toMatchObject({
      code: 'authentication-unavailable',
      message: 'auth-password: credential Provider is unavailable',
    })
    expect(JSON.stringify(error)).not.toContain('alice')
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  it('normalizes unexpected verification failures to a redacted availability failure', async () => {
    const { ctx, credentials } = await setup()
    credentials.verifyFailure = new Error('hash backend exposed candidate-secret')

    await expect(ctx.auth.authenticate(attempt('alice', 'candidate-secret')))
      .rejects.toMatchObject({
        code: 'authentication-unavailable',
        message: 'auth-password: credential Provider is unavailable',
      })
  })

  it('uses auth registry conflict rules and invalidates calls when the plugin unloads', async () => {
    const { ctx, plugin } = await setup()
    const current = await ctx.auth.authenticate(attempt('alice', 'correct-password'))
    const other: AuthenticationProvider<'password'> = {
      method: authenticationMethod('other-password'),
      verify: async () => ({ principal: { kind: 'user', id: TARGET }, authenticatedAt: Date.now() }),
    }
    expect(() => ctx.auth.providers.register('password', other)).toThrow(/evidence kind/)

    interface ExtraEvidenceMap {
      readonly extra: { readonly kind: 'extra' }
    }
    const registry = ctx.auth.providers as unknown as {
      register(kind: keyof ExtraEvidenceMap, provider: AuthenticationProvider): () => void
    }
    expect(() => registry.register('extra', {
      ...other,
      method: authenticationMethod('password'),
    })).toThrow(/method/)

    await plugin.dispose()
    expect(() => ctx.auth.assertCurrent(current)).toThrow(/current Provider/)
  })
})
