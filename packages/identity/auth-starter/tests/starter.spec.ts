import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AccountService, {
  AccountAdministrationService,
  AccountError,
  type RegistrationOperationAdvanceRequest,
  type RegistrationOperationProvider,
  type RegistrationOperationRecord,
} from '@deepseek-ai/dsh-account'
import AuthenticationRuntime, { type AuthenticationRequestId } from '@deepseek-ai/dsh-auth'
import AuthGatewayService from '@deepseek-ai/dsh-auth-gateway'
import type { UserRecord } from '@deepseek-ai/dsh-user'
import { MemoryAuthTokens } from '../../auth-token/tests/memory.ts'
import { MemoryUserCredentialService } from '../../user-credential/tests/memory.ts'
import { MemoryUserDirectory } from '../../user/tests/memory.ts'
import { afterEach, describe, expect, it } from 'vitest'
import * as MinimalStarter from '../src/minimal.ts'
import * as FullStarter from '../src/index.ts'
import {
  AUTH_PROVIDER_READINESS,
  assertAuthenticationAssembly,
  mountAuthenticationAssembly,
  prepareAuthenticationAssembly,
} from '../src/assembly.ts'

const JWT = {
  issuer: 'https://issuer.example',
  audience: 'dsh-test',
  activeKeyId: 'primary',
  keys: [{ keyId: 'primary', secret: Buffer.alloc(32, 7).toString('base64url') }],
} as const
const GATEWAY = { allowedOrigins: ['https://app.example'] } as const
const signal = new AbortController().signal

class MemoryRegistrationOperations implements RegistrationOperationProvider {
  private readonly records = new Map<AuthenticationRequestId, RegistrationOperationRecord>()

  begin(requestId: AuthenticationRequestId): Promise<RegistrationOperationRecord> {
    const existing = this.records.get(requestId)
    if (existing !== undefined) return Promise.resolve(existing)
    const record: RegistrationOperationRecord = { requestId, revision: 1, stage: 'begun' }
    this.records.set(requestId, record)
    return Promise.resolve(record)
  }

  read(requestId: AuthenticationRequestId): Promise<RegistrationOperationRecord | undefined> {
    return Promise.resolve(this.records.get(requestId))
  }

  advance(request: RegistrationOperationAdvanceRequest): Promise<RegistrationOperationRecord> {
    const previous = this.records.get(request.requestId)
    if (previous?.revision !== request.expectedRevision || previous.stage !== request.expectedStage) {
      throw new AccountError('conflict', 'starter test registration state changed')
    }
    const record: RegistrationOperationRecord = {
      requestId: request.requestId,
      revision: previous.revision + 1,
      stage: request.stage,
      userId: request.userId,
      ...(request.recovery === undefined ? {} : { recovery: request.recovery }),
    }
    this.records.set(request.requestId, record)
    return Promise.resolve(record)
  }

  complete(requestId: AuthenticationRequestId, expectedRevision: number, result: UserRecord): Promise<RegistrationOperationRecord> {
    const previous = this.records.get(requestId)
    if (previous?.revision !== expectedRevision || previous.stage !== 'password-set') {
      throw new AccountError('conflict', 'starter test registration completion changed')
    }
    const record: RegistrationOperationRecord = {
      requestId,
      revision: previous.revision + 1,
      stage: 'completed',
      userId: result.userId,
      result,
    }
    this.records.set(requestId, record)
    return Promise.resolve(record)
  }
}

async function provideMemoryServices(ctx: Context, registration = true): Promise<void> {
  await ctx.plugin(MemoryUserDirectory).await()
  await ctx.plugin(MemoryUserCredentialService).await()
  await ctx.plugin(MemoryAuthTokens).await()
  await ctx.plugin(AccountService).await()
  const accounts = ctx.get('accounts') as AccountService
  if (registration) ctx.effect(() => accounts.registrationOperations.register(new MemoryRegistrationOperations()))
  ctx.provide(AUTH_PROVIDER_READINESS, true)
}

const roots: Context[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  delete (globalThis as Record<string, unknown>).__authStarterProviderApply
  delete (globalThis as Record<string, unknown>).__authStarterMinimalApply
  delete (globalThis as Record<string, unknown>).__authStarterMinimalConfig
})

async function loaderComposition(): Promise<Context> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-auth-starter-'))
  const providerPath = join(directory, 'provider.mjs')
  const starterPath = join(directory, 'starter.mjs')
  writeFileSync(providerPath, "export const name='memory-auth-storage'; export const apply=ctx=>globalThis.__authStarterProviderApply(ctx)\n")
  writeFileSync(starterPath, [
    "export const name='auth-starter-minimal'",
    `export const inject=['users','userCredentials','authTokens','accounts','${AUTH_PROVIDER_READINESS}']`,
    'export const Config=globalThis.__authStarterMinimalConfig',
    'export const apply=(ctx,config)=>globalThis.__authStarterMinimalApply(ctx,config)',
    '',
  ].join('\n'))
  const globals = globalThis as unknown as {
    __authStarterProviderApply: typeof provideMemoryServices
    __authStarterMinimalApply: typeof MinimalStarter.apply
    __authStarterMinimalConfig: typeof MinimalStarter.Config
  }
  globals.__authStarterProviderApply = provideMemoryServices
  globals.__authStarterMinimalApply = MinimalStarter.apply
  globals.__authStarterMinimalConfig = MinimalStarter.Config
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Loader).await()
  const starter = ctx.loader.create({ name: pathToFileURL(starterPath).href, config: { jwt: JWT, gateway: GATEWAY } })
  await ctx.loader.create({ name: pathToFileURL(providerPath).href })
  await starter
  await ctx.loader.await()
  return ctx
}

function cookie(result: { cookies: readonly { name: string; value: string }[] }, name: string): string {
  const value = result.cookies.find(candidate => candidate.name === name)?.value
  if (value === undefined) throw new Error(`missing ${name}`)
  return value
}

function refreshRequest(requestId: string, refreshToken: string, csrf: string) {
  return {
    requestId,
    signal,
    headers: [
      { name: 'Origin', value: 'https://app.example' },
      { name: 'X-DSH-CSRF', value: csrf },
    ],
    cookies: [
      { name: '__Host-dsh_refresh', value: refreshToken },
      { name: '__Host-dsh_csrf', value: csrf },
    ],
  }
}

describe('auth starter composition', () => {
  it('orders the complete MySQL suite without owning child behavior', async () => {
    const mounted: unknown[] = []
    const services = new Map<string, unknown>()
    const accounts = { registrationOperations: { require: () => ({}) } }
    services.set('accounts', accounts)
    const fake = {
      get: (name: string) => services.get(name),
      plugin: (plugin: unknown) => {
        mounted.push(plugin)
        if (plugin === AuthenticationRuntime) {
          services.set('auth', {
            providers: { resolveEvidence: (kind: string) => kind === 'password' || kind === 'bearer' ? {} : undefined },
          })
        } else if (plugin === AccountAdministrationService) services.set('accountAdministration', {})
        else if (plugin === AuthGatewayService) services.set('authGateway', {})
        return Promise.resolve()
      },
    } as unknown as Context
    await FullStarter.apply(fake, {
      mysql: { host: 'db', user: 'dsh', password: 'secret', database: 'dsh' },
      jwt: JWT,
    })
    expect(mounted).toHaveLength(11)
    expect(services.get('auth')).toBeDefined()
    expect(services.get('authGateway')).toBeDefined()
  })

  it('fails closed for missing storage or assembled services', async () => {
    const empty = new Context()
    expect(() => { prepareAuthenticationAssembly(empty, { jwt: JWT }) }).toThrow(/account service/)
    expect(() => { assertAuthenticationAssembly(empty) }).toThrow(/authentication Providers/)

    const authOnly = {
      get: (name: string) => name === 'auth'
        ? { providers: { resolveEvidence: () => ({}) } }
        : undefined,
    } as unknown as Context
    expect(() => { assertAuthenticationAssembly(authOnly) }).toThrow(/account service/)

    const mounted = new Map<string, unknown>([['accounts', { registrationOperations: { require: () => ({}) } }]])
    const direct = {
      get: (name: string) => mounted.get(name),
      plugin: (plugin: unknown, config?: unknown) => {
        if (plugin === AuthenticationRuntime) {
          mounted.set('auth', { providers: { resolveEvidence: () => ({}) } })
        }
        if (plugin === AuthGatewayService) mounted.set('gateway-config', config)
        return Promise.resolve()
      },
    } as unknown as Context
    await mountAuthenticationAssembly(direct, { jwt: JWT })
    expect(mounted.get('gateway-config')).toEqual({})
  })

  it('boots through the real Loader and completes the public authentication lifecycle', async () => {
    const ctx = await loaderComposition()
    await expect(ctx.accountAdministration.authorizers.authorize({} as never, 'create'))
      .rejects.toMatchObject({ code: 'forbidden' })
    const registration = {
      requestId: 'register-1',
      signal,
      identifier: { kind: 'username', value: 'Alice' },
      password: 'correct horse battery staple',
      displayName: 'Alice',
    }
    const user = await ctx.authGateway.register(registration)
    await expect(ctx.authGateway.register(registration)).resolves.toEqual(user)

    const login = await ctx.authGateway.login({
      requestId: 'login-1', signal, headers: [], cookies: [], query: [],
      identifier: { kind: 'username', value: 'alice' }, password: registration.password,
    })
    await expect(ctx.authGateway.authenticateHttp({
      requestId: 'access-1', signal,
      headers: [{ name: 'Authorization', value: `Bearer ${login.accessToken}` }],
    })).resolves.toMatchObject({ principal: { kind: 'user', id: user.userId } })

    const oldRefresh = cookie(login, '__Host-dsh_refresh')
    const csrf = cookie(login, '__Host-dsh_csrf')
    const rotated = await ctx.authGateway.refresh(refreshRequest('refresh-1', oldRefresh, csrf))
    const newRefresh = cookie(rotated, '__Host-dsh_refresh')
    const newCsrf = cookie(rotated, '__Host-dsh_csrf')
    await expect(ctx.authGateway.refresh(refreshRequest('refresh-replay', oldRefresh, csrf)))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.authGateway.refresh(refreshRequest('refresh-revoked', newRefresh, newCsrf)))
      .rejects.toMatchObject({ code: 'unauthenticated' })

    const relogin = await ctx.authGateway.login({
      requestId: 'login-2', signal, identifier: { kind: 'username', value: 'alice' }, password: registration.password,
    })
    const logout = await ctx.authGateway.logout({
      requestId: 'logout-1', signal,
      headers: [{ name: 'Authorization', value: `Bearer ${relogin.accessToken}` }],
    })
    expect(logout.cookies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '__Host-dsh_refresh', maxAgeSeconds: 0 }),
      expect.objectContaining({ name: '__Host-dsh_csrf', maxAgeSeconds: 0 }),
    ]))
  })

  it('fails without a registration Provider and rolls back its mounted services', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await provideMemoryServices(ctx, false)
    expect(() => { prepareAuthenticationAssembly(ctx, { jwt: JWT }) }).toThrow(expect.objectContaining({ code: 'unavailable' }))
    expect(ctx.get('auth')).toBeUndefined()
    expect(ctx.get('authGateway')).toBeUndefined()
  })

  it('rejects weak JWT keys, Provider conflicts, and disposes every owned service', async () => {
    const weak = { ...JWT, keys: [{ keyId: 'primary', secret: Buffer.alloc(16).toString('base64url') }] }
    const weakContext = new Context()
    roots.push(weakContext)
    await provideMemoryServices(weakContext)
    expect(() => { prepareAuthenticationAssembly(weakContext, { jwt: weak }) }).toThrow(/32-128 bytes/)

    const ctx = new Context()
    roots.push(ctx)
    await provideMemoryServices(ctx)
    const first = ctx.plugin(MinimalStarter, { jwt: JWT })
    await first.await()
    expect(() => { prepareAuthenticationAssembly(ctx, { jwt: JWT }) }).toThrow(/already active/)
    await first.dispose()
    expect(ctx.get('auth')).toBeUndefined()
    expect(ctx.get('authGateway')).toBeUndefined()
    expect(ctx.get('accountAdministration')).toBeUndefined()
    expect(ctx.get('users')).toBeDefined()
  })
})
