import { Context, Service } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  AuthenticationError,
  authenticationMethod,
  authenticationRequestId,
  localPrincipalId,
  type AuthenticatedPrincipal,
  type AuthenticationProvider,
  type IssuedCredentialSet,
} from '@deepseek-ai/dsh-auth'
import * as PasswordAuthentication from '@deepseek-ai/dsh-auth-password'
import { UserCredentialError, type LoginIdentifierInput, type UserCredentialRecord } from '@deepseek-ai/dsh-user-credential'
import { UserDirectoryError, userId, type UserCreateInput, type UserRecord } from '@deepseek-ai/dsh-user'
import { describe, expect, it, vi } from 'vitest'
import AccountService, { AccountError } from '../src/index.ts'

const signal = new AbortController().signal
const requestId = authenticationRequestId('account-test')
const jwtMethod = authenticationMethod('jwt')

class FakeUsers extends Service {
  records = new Map<string, UserRecord>()
  contexts: unknown[] = []
  next = 1
  failCreate = false
  failDisable = false

  constructor(ctx: Context) { super(ctx, 'users') }

  create(input: UserCreateInput = {}): Promise<UserRecord> {
    if (this.failCreate) throw new UserDirectoryError('provider-unavailable', 'create failed')
    const id = userId(`user-${String(this.next++)}`)
    const record: UserRecord = Object.freeze({
      userId: id,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      extensions: input.extensions ?? {},
    })
    this.records.set(id, record)
    this.contexts.push(input.context)
    return Promise.resolve(record)
  }

  get(id: string): Promise<UserRecord | undefined> { return Promise.resolve(this.records.get(id)) }

  async requireActive(id: string): Promise<UserRecord> {
    const record = this.records.get(id)
    if (record === undefined) throw new UserDirectoryError('user-not-found', 'missing')
    if (record.status !== 'active') throw new UserDirectoryError('user-disabled', 'inactive')
    return record
  }

  update(request: {
    userId: string
    expectedRevision: number
    patch: { displayName?: string | null }
    context?: unknown
  }): Promise<UserRecord> {
    const record = this.requireRecord(request.userId, request.expectedRevision)
    const current: UserRecord = Object.freeze({
      ...record,
      ...(Object.hasOwn(request.patch, 'displayName')
        ? request.patch.displayName === null ? { displayName: undefined } : { displayName: request.patch.displayName }
        : {}),
      revision: record.revision + 1,
      updatedAt: record.updatedAt + 1,
    })
    this.records.set(request.userId, current)
    this.contexts.push(request.context)
    return Promise.resolve(current)
  }

  disable(request: { userId: string; expectedRevision: number; context?: unknown }): Promise<UserRecord> {
    if (this.failDisable) throw new UserDirectoryError('provider-unavailable', 'disable failed')
    return this.status(request, 'disabled')
  }

  enable(request: { userId: string; expectedRevision: number; context?: unknown }): Promise<UserRecord> {
    return this.status(request, 'active')
  }

  private status(request: { userId: string; expectedRevision: number; context?: unknown }, status: UserRecord['status']): Promise<UserRecord> {
    const record = this.requireRecord(request.userId, request.expectedRevision)
    const current = Object.freeze({ ...record, status, revision: record.revision + 1, updatedAt: record.updatedAt + 1 })
    this.records.set(request.userId, current)
    this.contexts.push(request.context)
    return Promise.resolve(current)
  }

  private requireRecord(id: string, revision: number): UserRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new UserDirectoryError('user-not-found', 'missing')
    if (record.revision !== revision) throw new UserDirectoryError('revision-conflict', 'stale')
    return record
  }
}

class FakeCredentials extends Service {
  records = new Map<string, UserCredentialRecord>()
  identifiers = new Map<string, string>()
  passwords = new Map<string, string>()
  contexts: unknown[] = []
  failAdd = false
  failSet = false
  failRemove = false

  constructor(ctx: Context) { super(ctx, 'userCredentials') }

  normalize(input: LoginIdentifierInput): Promise<LoginIdentifierInput> {
    return Promise.resolve({ kind: input.kind, value: input.value.trim().toLowerCase() })
  }

  async resolve(input: LoginIdentifierInput): Promise<ReturnType<typeof userId> | undefined> {
    const normalized = await this.normalize(input)
    const id = this.identifiers.get(`${normalized.kind}:${normalized.value}`)
    return id === undefined ? undefined : userId(id)
  }

  verifyPassword(request: { userId?: string; password: string }): Promise<boolean> {
    return Promise.resolve(request.userId !== undefined && this.passwords.get(request.userId) === request.password)
  }

  async addIdentifier(request: {
    userId: ReturnType<typeof userId>
    expectedRevision: number
    kind: string
    value: string
    context?: unknown
  }): Promise<UserCredentialRecord> {
    if (this.failAdd) throw new UserCredentialError('provider-unavailable', 'secret sql')
    if (request.expectedRevision !== 0 || this.records.has(request.userId)) throw new UserCredentialError('revision-conflict', 'stale')
    const normalized = await this.normalize(request)
    const key = `${normalized.kind}:${normalized.value}`
    if (this.identifiers.has(key)) throw new UserCredentialError('identifier-conflict', 'conflict')
    const record = this.record(request.userId, 1, false)
    this.records.set(request.userId, record)
    this.identifiers.set(key, request.userId)
    this.contexts.push(request.context)
    return record
  }

  async removeIdentifier(request: {
    userId: ReturnType<typeof userId>
    expectedRevision: number
    kind: string
    value: string
    context?: unknown
  }): Promise<UserCredentialRecord> {
    if (this.failRemove) throw new UserCredentialError('provider-unavailable', 'remove failed')
    const previous = this.require(request.userId, request.expectedRevision)
    const normalized = await this.normalize(request)
    this.identifiers.delete(`${normalized.kind}:${normalized.value}`)
    const record = this.record(request.userId, previous.revision + 1, previous.passwordEnabled)
    this.records.set(request.userId, record)
    return record
  }

  setPassword(request: {
    userId: ReturnType<typeof userId>
    expectedRevision: number
    password: string
    context?: unknown
  }): Promise<UserCredentialRecord> {
    if (this.failSet) throw new UserCredentialError('provider-unavailable', 'hash failed')
    const previous = this.require(request.userId, request.expectedRevision)
    const record = this.record(request.userId, previous.revision + 1, true)
    this.records.set(request.userId, record)
    this.passwords.set(request.userId, request.password)
    this.contexts.push(request.context)
    return Promise.resolve(record)
  }

  changePassword(request: {
    userId: ReturnType<typeof userId>
    expectedRevision: number
    currentPassword: string
    newPassword: string
    context?: unknown
  }): Promise<UserCredentialRecord> {
    const previous = this.require(request.userId, request.expectedRevision)
    if (this.passwords.get(request.userId) !== request.currentPassword) {
      throw new UserCredentialError('invalid-credential', 'wrong')
    }
    this.passwords.set(request.userId, request.newPassword)
    const record = this.record(request.userId, previous.revision + 1, true)
    this.records.set(request.userId, record)
    return Promise.resolve(record)
  }

  private require(id: ReturnType<typeof userId>, revision: number): UserCredentialRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new UserCredentialError('credential-not-found', 'missing')
    if (record.revision !== revision) throw new UserCredentialError('revision-conflict', 'stale')
    return record
  }

  private record(id: ReturnType<typeof userId>, revision: number, passwordEnabled: boolean): UserCredentialRecord {
    return Object.freeze({ userId: id, revision, identifiers: [], passwordEnabled, updatedAt: revision })
  }
}

interface Setup {
  ctx: Context
  users: FakeUsers
  credentials: FakeCredentials
  issued: IssuedCredentialSet[]
  revoked: string[]
  failRevoke: { value: boolean }
  failIssue: { value: boolean }
  setPrincipal(principal: AuthenticatedPrincipal): void
  passwordPlugin: ReturnType<Context['plugin']>
}

async function setup(): Promise<Setup> {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(FakeUsers)
  await ctx.plugin(FakeCredentials)
  const passwordPlugin = ctx.plugin(PasswordAuthentication)
  await passwordPlugin
  const issued: IssuedCredentialSet[] = []
  const revoked: string[] = []
  const failRevoke = { value: false }
  const failIssue = { value: false }
  const usedRefresh = new Set<string>()
  let principal: AuthenticatedPrincipal = { kind: 'user', id: userId('actor') }
  const jwt: AuthenticationProvider<'in-process'> = {
    method: jwtMethod,
    credentials: {
      issue: async (request) => {
        if (failIssue.value) throw new AuthenticationError('authentication-unavailable', 'issue failed')
        const result = Object.freeze({ credentials: Object.freeze([
          { kind: 'access' as const, id: `access-${request.principal.id}` as never, value: 'access-secret' },
          { kind: 'refresh' as const, id: `refresh-${request.principal.id}` as never, value: 'refresh-secret' },
        ]) })
        issued.push(result)
        return result
      },
      refresh: async (request) => {
        if (usedRefresh.has(request.refreshToken)) throw new AuthenticationError('unauthenticated', 'reused')
        usedRefresh.add(request.refreshToken)
        return { credentials: [{ kind: 'access', id: 'access-new' as never, value: 'new-access' }] }
      },
      revoke: async (request) => {
        if (failRevoke.value) throw new AuthenticationError('authentication-unavailable', 'down')
        if (request.target.kind === 'principal') revoked.push(request.target.principal.id)
      },
    },
    verify: async () => ({ principal, authenticatedAt: Date.now() }),
  }
  ctx.auth.providers.register('in-process', jwt)
  await ctx.plugin(AccountService)
  return {
    ctx,
    users: ctx.users as unknown as FakeUsers,
    credentials: ctx.userCredentials as unknown as FakeCredentials,
    issued,
    revoked,
    failRevoke,
    failIssue,
    passwordPlugin,
    setPrincipal(value) { principal = value },
  }
}

function registration() {
  return {
    requestId,
    signal,
    identifier: { kind: 'username', value: ' Alice ' },
    password: 'secret-password',
    displayName: 'Alice',
    extensions: { 'test/value': 'x' },
  } as const
}

async function currentCall(setup: Setup, id: ReturnType<typeof userId>) {
  setup.setPrincipal({ kind: 'user', id })
  return setup.ctx.auth.authenticate({ requestId, channel: 'in-process', evidence: { kind: 'in-process' }, signal })
}

describe('account orchestration', () => {
  it('registers in stable order, issues JWT credentials, and emits no secret material', async () => {
    const { ctx, credentials } = await setup()
    const events: unknown[] = []
    ctx.on('account/changed', (event) => { events.push(event) })

    const result = await ctx.accounts.register(registration())

    expect(result.user).toMatchObject({ status: 'active', displayName: 'Alice' })
    expect(result.credentials.credentials.map(value => value.kind)).toEqual(['access', 'refresh'])
    expect(credentials.records.get(result.user.userId)).toMatchObject({ revision: 2, passwordEnabled: true })
    expect(JSON.stringify(events)).not.toContain('secret-password')
    expect(JSON.stringify(events)).not.toContain('refresh-secret')
  })

  it('compensates identifier and user state when password setup fails', async () => {
    const { ctx, users, credentials } = await setup()
    credentials.failSet = true

    const error = await ctx.accounts.register(registration()).catch((cause: unknown) => cause as AccountError)

    expect(error).toMatchObject({ code: 'registration-incomplete', recovery: { compensationComplete: true, credentialsConfigured: false } })
    if (!(error instanceof AccountError)) throw new Error('expected account failure')
    expect(users.records.get(error.recovery?.userId as string)?.status).toBe('disabled')
    expect(credentials.identifiers.size).toBe(0)
  })

  it('reports an explicit recovery state when compensation also fails', async () => {
    const { ctx, credentials } = await setup()
    credentials.failSet = true
    credentials.failRemove = true

    await expect(ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete',
      recovery: { compensationComplete: false, credentialsConfigured: true },
    })
  })

  it('retains administrator actor context while compensating failed account creation', async () => {
    const current = await setup()
    const actor = (await current.users.create()).userId
    current.credentials.failSet = true

    await expect(current.ctx.accounts.adminCreate({
      actor: await currentCall(current, actor),
      ...registration(),
    })).rejects.toMatchObject({ code: 'registration-incomplete', recovery: { compensationComplete: true } })
  })

  it('disables a user when identifier creation fails', async () => {
    const { ctx, credentials } = await setup()
    credentials.failAdd = true
    await expect(ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery: { compensationComplete: true },
    })
  })

  it('rejects password login for an inactive user before JWT issuance', async () => {
    const { ctx, users, issued } = await setup()
    const registered = await ctx.accounts.register(registration())
    await users.disable({ userId: registered.user.userId, expectedRevision: 1 })
    issued.length = 0

    await expect(ctx.accounts.login({ ...registration(), channel: 'http' })).rejects.toMatchObject({ code: 'account-inactive' })
    expect(issued).toHaveLength(0)
  })

  it('logs in an active user and rejects wrong passwords generically', async () => {
    const { ctx } = await setup()
    const registered = await ctx.accounts.register(registration())
    await expect(ctx.accounts.login({ ...registration(), channel: 'http' })).resolves.toMatchObject({ user: { userId: registered.user.userId } })
    await expect(ctx.accounts.login({ ...registration(), password: 'wrong', channel: 'http' })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('rejects a non-user identity returned by a replacement password Provider', async () => {
    const current = await setup()
    await current.passwordPlugin.dispose()
    current.ctx.auth.providers.register('password', {
      method: authenticationMethod('password'),
      verify: async () => ({
        principal: { kind: 'local', id: localPrincipalId('local-password') },
        authenticatedAt: Date.now(),
      }),
    })

    await expect(current.ctx.accounts.login({ ...registration(), channel: 'http' }))
      .rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('rotates refresh credentials once and maps reuse to unauthenticated', async () => {
    const { ctx } = await setup()
    await expect(ctx.accounts.refresh({ requestId, signal, refreshToken: 'one' })).resolves.toBeDefined()
    await expect(ctx.accounts.refresh({ requestId, signal, refreshToken: 'one' })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('keeps administrator actor distinct from target and preserves stale revision conflicts', async () => {
    const current = await setup()
    const { ctx, users } = current
    const actor = (await users.create({ displayName: 'Admin' })).userId
    const target = (await users.create({ displayName: 'Target' })).userId
    const call = await currentCall(current, actor)

    const updated = await ctx.accounts.adminUpdate({
      actor: call,
      userId: target,
      expectedRevision: 1,
      patch: { displayName: 'Changed' },
      reason: 'support request',
    })
    expect(updated.userId).toBe(target)
    expect(users.contexts.at(-1)).toEqual({ actorUserId: actor, reason: 'support request' })
    await expect(ctx.accounts.adminUpdate({ actor: call, userId: target, expectedRevision: 1, patch: { displayName: 'Again' } }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('updates self profile and changes password before revoking every session', async () => {
    const current = await setup()
    const { ctx, revoked } = current
    const registered = await ctx.accounts.register(registration())
    const call = await currentCall(current, registered.user.userId)

    await expect(ctx.accounts.updateProfile({ call, expectedRevision: 1, patch: { displayName: 'Self' } }))
      .resolves.toMatchObject({ displayName: 'Self' })
    await expect(ctx.accounts.changePassword({
      call, requestId, signal, expectedCredentialRevision: 2,
      currentPassword: 'secret-password', newPassword: 'new-password',
    })).resolves.toMatchObject({ revision: 3 })
    expect(revoked).toContain(registered.user.userId)
  })

  it('reports committed password change when revocation fails', async () => {
    const current = await setup()
    const { ctx, failRevoke } = current
    const registered = await ctx.accounts.register(registration())
    const call = await currentCall(current, registered.user.userId)
    failRevoke.value = true

    await expect(ctx.accounts.changePassword({
      call, requestId, signal, expectedCredentialRevision: 2,
      currentPassword: 'secret-password', newPassword: 'new-password',
    })).rejects.toMatchObject({ code: 'session-revocation-incomplete', recovery: { operation: 'password-change' } })
  })

  it('supports administrator create, disable, enable, reset, revoke, and all-session logout', async () => {
    const current = await setup()
    const { ctx, users, revoked } = current
    const actor = (await users.create({ displayName: 'Admin' })).userId
    const actorCall = await currentCall(current, actor)
    const target = await ctx.accounts.adminCreate({ actor: actorCall, ...registration() })

    const disabled = await ctx.accounts.adminDisable({ actor: actorCall, userId: target.userId, expectedRevision: 1, requestId, signal })
    const enabled = await ctx.accounts.adminEnable({
      actor: actorCall,
      userId: target.userId,
      expectedRevision: disabled.revision,
      requestId,
      signal,
    })
    await ctx.accounts.adminResetPassword({ actor: actorCall, userId: target.userId, expectedCredentialRevision: 2, newPassword: 'reset', requestId, signal })
    await ctx.accounts.adminRevokeSessions({ actor: actorCall, userId: target.userId, requestId, signal })
    await ctx.accounts.logout(actorCall)

    expect(enabled.status).toBe('active')
    expect(revoked).toEqual([target.userId, target.userId, target.userId, actor])
  })

  it('requires current active user calls for self-service and administrator entry points', async () => {
    const current = await setup()
    const { ctx, users } = current
    const actor = (await users.create()).userId
    const call = await currentCall(current, actor)
    await users.disable({ userId: actor, expectedRevision: 1 })

    await expect(ctx.accounts.logout(call)).rejects.toMatchObject({ code: 'account-inactive' })
    await expect(ctx.accounts.logout({} as never)).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('reports credential issuance failure without rolling back a configured account', async () => {
    const current = await setup()
    current.failIssue.value = true

    await expect(current.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'unavailable',
      recovery: { operation: 'credential-issue', credentialsConfigured: true, compensationComplete: true },
    })
  })

  it('covers primary mutation and revocation failures with stable categories', async () => {
    const current = await setup()
    const { ctx, users, credentials, failRevoke } = current
    const registered = await ctx.accounts.register({
      requestId, signal, identifier: { kind: 'username', value: 'minimal' }, password: 'password',
    })
    const actor = (await users.create()).userId
    const call = await currentCall(current, actor)

    await expect(ctx.accounts.updateProfile({ call: await currentCall(current, registered.user.userId), expectedRevision: 99, patch: { displayName: 'x' } }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.accounts.changePassword({
      call: await currentCall(current, registered.user.userId), requestId, signal,
      expectedCredentialRevision: 2, currentPassword: 'wrong', newPassword: 'new',
    })).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.accounts.adminDisable({ actor: call, userId: registered.user.userId, expectedRevision: 99, requestId, signal }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.accounts.adminEnable({ actor: call, userId: registered.user.userId, expectedRevision: 99, requestId, signal }))
      .rejects.toMatchObject({ code: 'conflict' })
    credentials.failSet = true
    await expect(ctx.accounts.adminResetPassword({
      actor: call, userId: registered.user.userId, expectedCredentialRevision: 2,
      newPassword: 'new', requestId, signal,
    })).rejects.toMatchObject({ code: 'unavailable' })
    credentials.failSet = false
    failRevoke.value = true
    await expect(ctx.accounts.logout(call)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(ctx.accounts.adminRevokeSessions({ actor: call, userId: registered.user.userId, requestId, signal }))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('reports committed administrator mutations when session revocation fails', async () => {
    const disabledCase = await setup()
    const disabledActor = (await disabledCase.users.create()).userId
    const disabledTarget = await disabledCase.ctx.accounts.adminCreate({
      actor: await currentCall(disabledCase, disabledActor), ...registration(),
    })
    disabledCase.failRevoke.value = true
    await expect(disabledCase.ctx.accounts.adminDisable({
      actor: await currentCall(disabledCase, disabledActor), userId: disabledTarget.userId,
      expectedRevision: 1, requestId, signal,
    })).rejects.toMatchObject({ code: 'session-revocation-incomplete', recovery: { operation: 'disable' } })

    const resetCase = await setup()
    const resetActor = (await resetCase.users.create()).userId
    const resetTarget = await resetCase.ctx.accounts.adminCreate({
      actor: await currentCall(resetCase, resetActor), ...registration(),
    })
    resetCase.failRevoke.value = true
    await expect(resetCase.ctx.accounts.adminResetPassword({
      actor: await currentCall(resetCase, resetActor), userId: resetTarget.userId,
      expectedCredentialRevision: 2, newPassword: 'reset', requestId, signal,
    })).rejects.toMatchObject({ code: 'session-revocation-incomplete', recovery: { operation: 'password-reset' } })
  })

  it('maps all owned dependency failures without retaining their diagnostics', async () => {
    const { ctx } = await setup()
    const internals = ctx.accounts as unknown as {
      map(cause: unknown): AccountError
      operation(request: { requestId: unknown; signal: unknown }): void
    }
    const original = new AccountError('conflict', 'fixed')
    expect(internals.map(original)).toBe(original)
    expect(internals.map(new UserDirectoryError('user-deleted', 'secret'))).toMatchObject({ code: 'account-inactive' })
    expect(internals.map(new UserDirectoryError('status-conflict', 'secret'))).toMatchObject({ code: 'conflict' })
    expect(internals.map(new UserDirectoryError('invalid-input', 'secret'))).toMatchObject({ code: 'invalid-input' })
    expect(internals.map(new UserDirectoryError('user-not-found', 'secret'))).toMatchObject({ code: 'invalid-input' })
    expect(internals.map(new UserCredentialError('identifier-conflict', 'secret'))).toMatchObject({ code: 'conflict' })
    expect(internals.map(new UserCredentialError('credential-not-found', 'secret'))).toMatchObject({ code: 'invalid-input' })
    expect(internals.map(new UserCredentialError('provider-unavailable', 'secret'))).toMatchObject({ code: 'unavailable' })
    expect(internals.map(new Error('secret'))).toMatchObject({ code: 'unavailable' })
    expect(() => { internals.operation({ requestId: 1, signal }) })
      .toThrow(expect.objectContaining({ code: 'invalid-input' }))
  })

  it('rejects non-user calls and handles failed user creation and compensation', async () => {
    const localCase = await setup()
    localCase.setPrincipal({ kind: 'local', id: localPrincipalId('local-test') })
    const localCall = await localCase.ctx.auth.authenticate({
      requestId, channel: 'in-process', evidence: { kind: 'in-process' }, signal,
    })
    await expect(localCase.ctx.accounts.logout(localCall)).rejects.toMatchObject({ code: 'unauthenticated' })

    const createCase = await setup()
    createCase.users.failCreate = true
    await expect(createCase.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })

    const compensateCase = await setup()
    compensateCase.credentials.failAdd = true
    compensateCase.users.failDisable = true
    await expect(compensateCase.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery: { compensationComplete: false },
    })
  })

  it('rejects cancelled operations and contains asynchronous event listener failures', async () => {
    const { ctx } = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.accounts.register({ ...registration(), signal: controller.signal })).rejects.toMatchObject({ code: 'unauthenticated' })

    const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const asyncListener = (() => Promise.reject(new Error('listener failed'))) as unknown as () => void
    ctx.on('account/changed', asyncListener)
    ctx.on('account/changed', () => { throw new Error('sync listener failed') })
    await ctx.accounts.register(registration())
    await vi.waitFor(() => { expect(warning).toHaveBeenCalled() })
  })
})
