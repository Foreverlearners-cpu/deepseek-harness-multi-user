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
import AccountService, {
  AccountAdministrationService,
  AccountAdminAuthorizerRegistry,
  AccountError,
  RegistrationOperationProviderRegistry,
  type AccountAdminAuthorizationRequest,
  type RegistrationOperationAdvanceRequest,
  type RegistrationOperationProvider,
  type RegistrationOperationRecord,
} from '../src/index.ts'

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
  throwAfterAdd = false
  throwAfterSet = false
  failNormalize = false
  failDisablePassword = false
  failGetCall?: number
  getCalls = 0

  constructor(ctx: Context) { super(ctx, 'userCredentials') }

  normalize(input: LoginIdentifierInput): Promise<LoginIdentifierInput> {
    if (this.failNormalize) throw new UserCredentialError('invalid-input', 'normalize failed')
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

  get(id: ReturnType<typeof userId>): Promise<UserCredentialRecord | undefined> {
    this.getCalls++
    if (this.failGetCall === this.getCalls) throw new UserCredentialError('provider-unavailable', 'get failed')
    return Promise.resolve(this.records.get(id))
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
    this.identifiers.set(key, request.userId)
    const record = this.record(request.userId, 1, false)
    this.records.set(request.userId, record)
    this.contexts.push(request.context)
    if (this.throwAfterAdd) throw new UserCredentialError('provider-unavailable', 'committed add')
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
    if (this.throwAfterSet) throw new UserCredentialError('provider-unavailable', 'committed set')
    return Promise.resolve(record)
  }

  disablePassword(request: { userId: ReturnType<typeof userId>; expectedRevision: number }): Promise<UserCredentialRecord> {
    if (this.failDisablePassword) throw new UserCredentialError('provider-unavailable', 'disable failed')
    const previous = this.require(request.userId, request.expectedRevision)
    this.passwords.delete(request.userId)
    const record = this.record(request.userId, previous.revision + 1, false)
    this.records.set(request.userId, record)
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
    const identifiers = [...this.identifiers.entries()]
      .filter(([, owner]) => owner === id)
      .map(([key]) => {
        const separator = key.indexOf(':')
        return { kind: key.slice(0, separator), value: key.slice(separator + 1), createdAt: 1 }
      })
    return Object.freeze({ userId: id, revision, identifiers, passwordEnabled, updatedAt: revision })
  }
}

class MemoryRegistrationOperations implements RegistrationOperationProvider {
  readonly records = new Map<string, RegistrationOperationRecord>()
  failBegin = false
  failComplete = false
  failAdvanceStage?: RegistrationOperationAdvanceRequest['stage']

  begin(id: typeof requestId): Promise<RegistrationOperationRecord> {
    if (this.failBegin) throw new Error('operation backend failed')
    const existing = this.records.get(id)
    if (existing !== undefined) return Promise.resolve(existing)
    const record: RegistrationOperationRecord = Object.freeze({ requestId: id, revision: 1, stage: 'begun' })
    this.records.set(id, record)
    return Promise.resolve(record)
  }

  read(id: typeof requestId): Promise<RegistrationOperationRecord | undefined> {
    return Promise.resolve(this.records.get(id))
  }

  advance(request: RegistrationOperationAdvanceRequest): Promise<RegistrationOperationRecord> {
    if (this.failAdvanceStage === request.stage) throw new Error('operation advance failed')
    const previous = this.records.get(request.requestId)
    if (previous?.revision !== request.expectedRevision || previous.stage !== request.expectedStage) {
      throw new AccountError('conflict', 'test registration CAS failed')
    }
    const record: RegistrationOperationRecord = Object.freeze({
      requestId: request.requestId,
      revision: previous.revision + 1,
      stage: request.stage,
      userId: request.userId,
      ...(request.recovery === undefined ? {} : { recovery: request.recovery }),
    })
    this.records.set(request.requestId, record)
    return Promise.resolve(record)
  }

  complete(id: typeof requestId, revision: number, result: UserRecord): Promise<RegistrationOperationRecord> {
    if (this.failComplete) throw new Error('operation complete failed')
    const previous = this.records.get(id)
    if (previous?.revision !== revision || previous.stage !== 'password-set') {
      throw new AccountError('conflict', 'test registration completion CAS failed')
    }
    const record: RegistrationOperationRecord = Object.freeze({
      requestId: id,
      revision: previous.revision + 1,
      stage: 'completed',
      userId: result.userId,
      result,
    })
    this.records.set(id, record)
    return Promise.resolve(record)
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
  registrationOperations: MemoryRegistrationOperations
  afterIssue: { value?: () => Promise<void> }
  refreshFamily: { value?: string }
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
  const afterIssue: { value?: () => Promise<void> } = {}
  const refreshFamily: { value?: string } = {}
  const usedRefresh = new Set<string>()
  let principal: AuthenticatedPrincipal = { kind: 'user', id: userId('actor') }
  const jwt: AuthenticationProvider<'in-process'> = {
    method: jwtMethod,
    credentials: {
      issue: async (request) => {
        if (failIssue.value) throw new AuthenticationError('authentication-unavailable', 'issue failed')
        const result = Object.freeze({ credentials: Object.freeze([
          { kind: 'access' as const, id: `access-${request.principal.id}` as never, value: 'access-secret' },
          {
            kind: 'refresh' as const,
            id: `refresh-${request.principal.id}` as never,
            value: 'refresh-secret',
            ...(refreshFamily.value === undefined ? {} : { tokenFamilyId: refreshFamily.value as never }),
          },
        ]) })
        issued.push(result)
        await afterIssue.value?.()
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
        if (request.target.kind === 'token-family') revoked.push(request.target.tokenFamilyId)
      },
    },
    verify: async () => ({ principal, authenticatedAt: Date.now() }),
  }
  ctx.auth.providers.register('in-process', jwt)
  await ctx.plugin(AccountService)
  await ctx.plugin(AccountAdministrationService)
  const registrationOperations = new MemoryRegistrationOperations()
  ctx.accounts.registrationOperations.register(registrationOperations)
  return {
    ctx,
    users: ctx.users as unknown as FakeUsers,
    credentials: ctx.userCredentials as unknown as FakeCredentials,
    issued,
    revoked,
    failRevoke,
    failIssue,
    passwordPlugin,
    registrationOperations,
    afterIssue,
    refreshFamily,
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

function allowAdmin(setup: Setup, inspect?: (request: AccountAdminAuthorizationRequest) => void): void {
  setup.ctx.accountAdministration.authorizers.register({
    authorize: (request) => {
      inspect?.(request)
      return Promise.resolve()
    },
  })
}

describe('account orchestration', () => {
  it('enforces unique disposable registration and administrator Providers', async () => {
    const registrationRegistry = new RegistrationOperationProviderRegistry()
    const operations = new MemoryRegistrationOperations()
    expect(() => registrationRegistry.require()).toThrow(expect.objectContaining({ code: 'unavailable' }))
    const disposeOperations = registrationRegistry.register(operations)
    expect(registrationRegistry.require()).toBe(operations)
    expect(() => registrationRegistry.register(new MemoryRegistrationOperations()))
      .toThrow(expect.objectContaining({ code: 'conflict' }))
    disposeOperations()
    disposeOperations()
    expect(() => registrationRegistry.require()).toThrow(expect.objectContaining({ code: 'unavailable' }))

    const staleOperations = new RegistrationOperationProviderRegistry()
    const firstOperations = new MemoryRegistrationOperations()
    const replacementOperations = new MemoryRegistrationOperations()
    const disposeStaleOperations = staleOperations.register(firstOperations)
    ;(staleOperations as unknown as { provider: RegistrationOperationProvider }).provider = replacementOperations
    disposeStaleOperations()
    expect(staleOperations.require()).toBe(replacementOperations)

    const authorizers = new AccountAdminAuthorizerRegistry()
    const authorizer = { authorize: () => Promise.resolve() }
    const disposeAuthorizer = authorizers.register(authorizer)
    expect(() => authorizers.register(authorizer)).toThrow(expect.objectContaining({ code: 'conflict' }))
    disposeAuthorizer()
    disposeAuthorizer()
    await expect(authorizers.authorize({} as never, 'create')).rejects.toMatchObject({ code: 'forbidden' })

    const staleAuthorizers = new AccountAdminAuthorizerRegistry()
    const disposeStaleAuthorizer = staleAuthorizers.register(authorizer)
    const replacementAuthorizer = { authorize: () => Promise.resolve() }
    ;(staleAuthorizers as unknown as { provider: typeof authorizer }).provider = replacementAuthorizer
    disposeStaleAuthorizer()
    await expect(staleAuthorizers.authorize({} as never, 'create')).resolves.toBeUndefined()
  })

  it('resumes every durable registration stage without creating another user', async () => {
    const userCreated = await setup()
    const firstUser = await userCreated.users.create()
    userCreated.registrationOperations.records.set(requestId, {
      requestId, revision: 2, stage: 'user-created', userId: firstUser.userId,
    })
    await expect(userCreated.ctx.accounts.register(registration())).resolves.toMatchObject({ userId: firstUser.userId })
    expect(userCreated.users.records).toHaveLength(1)

    const identifierAdded = await setup()
    const secondUser = await identifierAdded.users.create()
    await identifierAdded.credentials.addIdentifier({
      userId: secondUser.userId, expectedRevision: 0, kind: 'username', value: 'alice',
    })
    identifierAdded.registrationOperations.records.set(requestId, {
      requestId, revision: 3, stage: 'identifier-added', userId: secondUser.userId,
    })
    await expect(identifierAdded.ctx.accounts.register(registration())).resolves.toMatchObject({ userId: secondUser.userId })

    const passwordSet = await setup()
    const thirdUser = await passwordSet.users.create()
    await passwordSet.credentials.addIdentifier({
      userId: thirdUser.userId, expectedRevision: 0, kind: 'username', value: 'alice',
    })
    await passwordSet.credentials.setPassword({
      userId: thirdUser.userId, expectedRevision: 1, password: 'secret-password',
    })
    passwordSet.registrationOperations.records.set(requestId, {
      requestId, revision: 4, stage: 'password-set', userId: thirdUser.userId,
    })
    await expect(passwordSet.ctx.accounts.register(registration())).resolves.toMatchObject({ userId: thirdUser.userId })
  })

  it('maps registration operation failures and rejects inconsistent durable records', async () => {
    const begin = await setup()
    begin.registrationOperations.failBegin = true
    await expect(begin.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })

    const advance = await setup()
    advance.registrationOperations.failAdvanceStage = 'user-created'
    await expect(advance.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery: { compensationComplete: true },
    })

    const complete = await setup()
    complete.registrationOperations.failComplete = true
    await expect(complete.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })

    const failed = await setup()
    failed.registrationOperations.records.set(requestId, {
      requestId, revision: 2, stage: 'failed', userId: userId('user-1'),
    })
    await expect(failed.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })

    const completed = await setup()
    completed.registrationOperations.records.set(requestId, {
      requestId, revision: 2, stage: 'completed', userId: userId('user-1'),
    })
    await expect(completed.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })

    const missingUser = await setup()
    missingUser.registrationOperations.records.set(requestId, {
      requestId, revision: 2, stage: 'user-created', userId: userId('missing'),
    })
    await expect(missingUser.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })

    const persistedFailure = await setup()
    const persistedUser = await persistedFailure.users.create()
    const recovery = {
      userId: persistedUser.userId,
      operation: 'registration' as const,
      userStatus: 'disabled' as const,
      credentialsConfigured: true,
      compensationComplete: false,
    }
    persistedFailure.registrationOperations.records.set(requestId, {
      requestId, revision: 3, stage: 'failed', userId: persistedUser.userId, recovery,
    })
    await expect(persistedFailure.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery,
    })

    const unknownStage = await setup()
    unknownStage.registrationOperations.records.set(requestId, {
      requestId, revision: 2, stage: 'unknown', userId: userId('user-1'),
    } as unknown as RegistrationOperationRecord)
    await expect(unknownStage.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('reconciles resumed credentials and rejects unexpected durable transitions', async () => {
    const existingIdentifier = await setup()
    const identifierUser = await existingIdentifier.users.create()
    await existingIdentifier.credentials.addIdentifier({
      userId: identifierUser.userId, expectedRevision: 0, kind: 'username', value: 'alice',
    })
    existingIdentifier.registrationOperations.records.set(requestId, {
      requestId, revision: 2, stage: 'user-created', userId: identifierUser.userId,
    })
    await expect(existingIdentifier.ctx.accounts.register(registration())).resolves.toMatchObject({ userId: identifierUser.userId })

    const existingPassword = await setup()
    const passwordUser = await existingPassword.users.create()
    await existingPassword.credentials.addIdentifier({
      userId: passwordUser.userId, expectedRevision: 0, kind: 'username', value: 'alice',
    })
    await existingPassword.credentials.setPassword({
      userId: passwordUser.userId, expectedRevision: 1, password: 'secret-password',
    })
    existingPassword.registrationOperations.records.set(requestId, {
      requestId, revision: 3, stage: 'identifier-added', userId: passwordUser.userId,
    })
    await expect(existingPassword.ctx.accounts.register(registration())).resolves.toMatchObject({ userId: passwordUser.userId })

    const missingCredential = await setup()
    const missingCredentialUser = await missingCredential.users.create()
    missingCredential.registrationOperations.records.set(requestId, {
      requestId, revision: 3, stage: 'identifier-added', userId: missingCredentialUser.userId,
    })
    await expect(missingCredential.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery: { credentialsConfigured: false },
    })

    const unexpectedTransition = await setup()
    unexpectedTransition.registrationOperations.advance = async request => ({
      requestId: request.requestId,
      revision: request.expectedRevision + 1,
      stage: 'failed',
      userId: request.userId,
      recovery: {
        userId: request.userId,
        operation: 'registration',
        userStatus: 'disabled',
        credentialsConfigured: true,
        compensationComplete: false,
      },
    })
    await expect(unexpectedTransition.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('registers in stable order, issues JWT credentials, and emits no secret material', async () => {
    const { ctx, credentials } = await setup()
    const events: unknown[] = []
    ctx.on('account/changed', (event) => { events.push(event) })

    const result = await ctx.accounts.register(registration())

    expect(result).toMatchObject({ status: 'active', displayName: 'Alice' })
    expect(credentials.records.get(result.userId)).toMatchObject({ revision: 2, passwordEnabled: true })
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
    allowAdmin(current)
    current.credentials.failSet = true

    await expect(current.ctx.accountAdministration.adminCreate({
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
    await users.disable({ userId: registered.userId, expectedRevision: 1 })
    issued.length = 0

    await expect(ctx.accounts.login({ ...registration(), channel: 'http' })).rejects.toMatchObject({ code: 'account-inactive' })
    expect(issued).toHaveLength(0)
  })

  it('logs in an active user and rejects wrong passwords generically', async () => {
    const { ctx } = await setup()
    const registered = await ctx.accounts.register(registration())
    await expect(ctx.accounts.login({ ...registration(), channel: 'http' })).resolves.toMatchObject({ user: { userId: registered.userId } })
    await expect(ctx.accounts.login({ ...registration(), password: 'wrong', channel: 'http' })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('revokes a newly issued family when an administrative reset crosses login', async () => {
    const current = await setup()
    const registered = await current.ctx.accounts.register(registration())
    current.afterIssue.value = async () => {
      await current.credentials.setPassword({
        userId: registered.userId,
        expectedRevision: 2,
        password: 'reset-password',
      })
    }

    await expect(current.ctx.accounts.login({ ...registration(), channel: 'http' }))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    expect(current.revoked).toContain(registered.userId)
  })

  it('revokes a newly issued family when a self password change crosses login', async () => {
    const current = await setup()
    const registered = await current.ctx.accounts.register(registration())
    current.afterIssue.value = async () => {
      await current.credentials.changePassword({
        userId: registered.userId,
        expectedRevision: 2,
        currentPassword: 'secret-password',
        newPassword: 'changed-password',
      })
    }

    await expect(current.ctx.accounts.login({ ...registration(), channel: 'http' }))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    expect(current.revoked).toContain(registered.userId)
  })

  it('reconciles credential commits that throw after persistence', async () => {
    const addCase = await setup()
    addCase.credentials.throwAfterAdd = true
    await expect(addCase.ctx.accounts.register(registration())).resolves.toMatchObject({ status: 'active' })

    const passwordCase = await setup()
    passwordCase.credentials.throwAfterSet = true
    await expect(passwordCase.ctx.accounts.register(registration())).resolves.toMatchObject({ status: 'active' })
    expect(passwordCase.credentials.records.get(userId('user-1'))).toMatchObject({
      revision: 2,
      passwordEnabled: true,
    })

    const unknownAddState = await setup()
    unknownAddState.credentials.failAdd = true
    unknownAddState.credentials.failGetCall = 2
    await expect(unknownAddState.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery: { credentialsConfigured: false },
    })

    const unknownPasswordState = await setup()
    const unknownPasswordUser = await unknownPasswordState.users.create()
    await unknownPasswordState.credentials.addIdentifier({
      userId: unknownPasswordUser.userId, expectedRevision: 0, kind: 'username', value: 'alice',
    })
    unknownPasswordState.registrationOperations.records.set(requestId, {
      requestId, revision: 3, stage: 'identifier-added', userId: unknownPasswordUser.userId,
    })
    unknownPasswordState.credentials.failSet = true
    unknownPasswordState.credentials.failGetCall = 2
    await expect(unknownPasswordState.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery: { credentialsConfigured: false },
    })
  })

  it('maps identifier normalization and durable advance failures', async () => {
    const normalize = await setup()
    normalize.credentials.failNormalize = true
    await expect(normalize.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'invalid-input' })

    const advance = await setup()
    advance.registrationOperations.failAdvanceStage = 'identifier-added'
    await expect(advance.ctx.accounts.register(registration())).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('cleans password state at its actual revision and reports cleanup failure conservatively', async () => {
    const clean = await setup()
    const user = await clean.users.create()
    await clean.credentials.addIdentifier({ userId: user.userId, expectedRevision: 0, kind: 'username', value: 'alice' })
    const credential = await clean.credentials.setPassword({
      userId: user.userId, expectedRevision: 1, password: 'secret-password',
    })
    clean.credentials.identifiers.clear()
    clean.credentials.records.set(user.userId, { ...credential, identifiers: [] })
    clean.registrationOperations.records.set(requestId, {
      requestId, revision: 3, stage: 'identifier-added', userId: user.userId,
    })
    await expect(clean.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery: { credentialsConfigured: false, compensationComplete: true },
    })

    const uncertain = await setup()
    const uncertainUser = await uncertain.users.create()
    await uncertain.credentials.addIdentifier({
      userId: uncertainUser.userId, expectedRevision: 0, kind: 'username', value: 'alice',
    })
    const uncertainCredential = await uncertain.credentials.setPassword({
      userId: uncertainUser.userId, expectedRevision: 1, password: 'secret-password',
    })
    uncertain.credentials.identifiers.clear()
    uncertain.credentials.records.set(uncertainUser.userId, { ...uncertainCredential, identifiers: [] })
    uncertain.credentials.failDisablePassword = true
    uncertain.registrationOperations.records.set(requestId, {
      requestId, revision: 3, stage: 'identifier-added', userId: uncertainUser.userId,
    })
    await expect(uncertain.ctx.accounts.register(registration())).rejects.toMatchObject({
      code: 'registration-incomplete', recovery: { credentialsConfigured: true, compensationComplete: false },
    })
  })

  it('revokes issuance when the post-authentication credential read fails', async () => {
    const current = await setup()
    const registered = await current.ctx.accounts.register(registration())
    current.credentials.getCalls = 0
    current.credentials.failGetCall = 2

    await expect(current.ctx.accounts.login({ ...registration(), channel: 'http' }))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(current.revoked).toContain(registered.userId)
  })

  it('revokes the issued refresh token family when credential state changes', async () => {
    const current = await setup()
    const registered = await current.ctx.accounts.register(registration())
    current.refreshFamily.value = 'family-1'
    current.afterIssue.value = async () => {
      await current.credentials.changePassword({
        userId: registered.userId,
        expectedRevision: 2,
        currentPassword: 'secret-password',
        newPassword: 'changed-password',
      })
    }

    await expect(current.ctx.accounts.login({ ...registration(), channel: 'http' }))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    expect(current.revoked).toContain('family-1')
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
    allowAdmin(current)
    const actor = (await users.create({ displayName: 'Admin' })).userId
    const target = (await users.create({ displayName: 'Target' })).userId
    const call = await currentCall(current, actor)

    const updated = await ctx.accountAdministration.adminUpdate({
      actor: call,
      userId: target,
      expectedRevision: 1,
      patch: { displayName: 'Changed' },
      reason: 'support request',
    })
    expect(updated.userId).toBe(target)
    expect(users.contexts.at(-1)).toEqual({ actorUserId: actor, reason: 'support request' })
    await expect(ctx.accountAdministration.adminUpdate({ actor: call, userId: target, expectedRevision: 1, patch: { displayName: 'Again' } }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('fails administrator operations closed and honors authorizer rejection or approval', async () => {
    const missing = await setup()
    expect(missing.ctx.accountAdministration).not.toHaveProperty('register')
    expect(missing.ctx.accountAdministration).not.toHaveProperty('login')
    const actor = (await missing.users.create()).userId
    const target = (await missing.users.create()).userId
    const actorCall = await currentCall(missing, actor)
    await expect(missing.ctx.accountAdministration.adminUpdate({
      actor: actorCall,
      userId: target,
      expectedRevision: 1,
      patch: { displayName: 'denied' },
    })).rejects.toMatchObject({ code: 'forbidden' })

    const rejected = await setup()
    const rejectedActor = (await rejected.users.create()).userId
    const rejectedTarget = (await rejected.users.create()).userId
    rejected.ctx.accountAdministration.authorizers.register({
      authorize: () => Promise.reject(new Error('policy diagnostics')),
    })
    await expect(rejected.ctx.accountAdministration.adminUpdate({
      actor: await currentCall(rejected, rejectedActor),
      userId: rejectedTarget,
      expectedRevision: 1,
      patch: { displayName: 'denied' },
    })).rejects.toMatchObject({
      code: 'forbidden',
      message: 'account: administrator authorization was denied',
    })

    const allowed = await setup()
    const allowedActor = (await allowed.users.create()).userId
    const allowedTarget = (await allowed.users.create()).userId
    const authorizations: AccountAdminAuthorizationRequest[] = []
    allowAdmin(allowed, (request) => { authorizations.push(request) })
    await expect(allowed.ctx.accountAdministration.adminUpdate({
      actor: await currentCall(allowed, allowedActor),
      userId: allowedTarget,
      expectedRevision: 1,
      patch: { displayName: 'allowed' },
    })).resolves.toMatchObject({ displayName: 'allowed' })
    expect(authorizations).toMatchObject([{ action: 'update', target: allowedTarget }])
  })

  it('updates self profile and changes password before revoking every session', async () => {
    const current = await setup()
    const { ctx, revoked } = current
    const registered = await ctx.accounts.register(registration())
    const call = await currentCall(current, registered.userId)

    await expect(ctx.accounts.updateProfile({ call, expectedRevision: 1, displayName: 'Self' }))
      .resolves.toMatchObject({ displayName: 'Self' })
    await expect(ctx.accounts.changePassword({
      call, requestId, signal, expectedCredentialRevision: 2,
      currentPassword: 'secret-password', newPassword: 'new-password',
    })).resolves.toMatchObject({ revision: 3 })
    expect(revoked).toContain(registered.userId)
  })

  it('reports committed password change when revocation fails', async () => {
    const current = await setup()
    const { ctx, failRevoke } = current
    const registered = await ctx.accounts.register(registration())
    const call = await currentCall(current, registered.userId)
    failRevoke.value = true

    await expect(ctx.accounts.changePassword({
      call, requestId, signal, expectedCredentialRevision: 2,
      currentPassword: 'secret-password', newPassword: 'new-password',
    })).rejects.toMatchObject({ code: 'session-revocation-incomplete', recovery: { operation: 'password-change' } })
  })

  it('supports administrator create, disable, enable, reset, revoke, and all-session logout', async () => {
    const current = await setup()
    const { ctx, users, revoked } = current
    allowAdmin(current)
    const actor = (await users.create({ displayName: 'Admin' })).userId
    const actorCall = await currentCall(current, actor)
    const target = await ctx.accountAdministration.adminCreate({ actor: actorCall, ...registration() })

    const disabled = await ctx.accountAdministration.adminDisable({
      actor: actorCall, userId: target.userId, expectedRevision: 1, requestId, signal,
    })
    const enabled = await ctx.accountAdministration.adminEnable({
      actor: actorCall,
      userId: target.userId,
      expectedRevision: disabled.revision,
      requestId,
      signal,
    })
    await ctx.accountAdministration.adminResetPassword({ actor: actorCall, userId: target.userId, expectedCredentialRevision: 2, newPassword: 'reset', requestId, signal })
    await ctx.accountAdministration.adminRevokeSessions({ actor: actorCall, userId: target.userId, requestId, signal })
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
    await expect(ctx.accounts.logout({} as never)).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('returns the same durable registration result for a completed retry', async () => {
    const current = await setup()
    const first = await current.ctx.accounts.register(registration())
    const second = await current.ctx.accounts.register({ ...registration(), password: 'ignored-retry-secret' })
    const operation = await current.registrationOperations.read(requestId)

    expect(second).toEqual(first)
    expect(current.users.records).toHaveLength(1)
    expect(operation).toMatchObject({ stage: 'completed', result: first })
  })

  it('covers primary mutation and revocation failures with stable categories', async () => {
    const current = await setup()
    const { ctx, users, credentials, failRevoke } = current
    allowAdmin(current)
    const registered = await ctx.accounts.register({
      requestId, signal, identifier: { kind: 'username', value: 'minimal' }, password: 'password',
    })
    const actor = (await users.create()).userId
    const call = await currentCall(current, actor)

    await expect(ctx.accounts.updateProfile({ call: await currentCall(current, registered.userId), expectedRevision: 99, displayName: 'x' }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.accounts.changePassword({
      call: await currentCall(current, registered.userId), requestId, signal,
      expectedCredentialRevision: 2, currentPassword: 'wrong', newPassword: 'new',
    })).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.accountAdministration.adminDisable({
      actor: call, userId: registered.userId, expectedRevision: 99, requestId, signal,
    }))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(ctx.accountAdministration.adminEnable({ actor: call, userId: registered.userId, expectedRevision: 99, requestId, signal }))
      .rejects.toMatchObject({ code: 'conflict' })
    credentials.failSet = true
    await expect(ctx.accountAdministration.adminResetPassword({
      actor: call, userId: registered.userId, expectedCredentialRevision: 2,
      newPassword: 'new', requestId, signal,
    })).rejects.toMatchObject({ code: 'unavailable' })
    credentials.failSet = false
    failRevoke.value = true
    await expect(ctx.accounts.logout(call)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(ctx.accountAdministration.adminRevokeSessions({ actor: call, userId: registered.userId, requestId, signal }))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('reports committed administrator mutations when session revocation fails', async () => {
    const disabledCase = await setup()
    allowAdmin(disabledCase)
    const disabledActor = (await disabledCase.users.create()).userId
    const disabledTarget = await disabledCase.ctx.accountAdministration.adminCreate({
      actor: await currentCall(disabledCase, disabledActor), ...registration(),
    })
    disabledCase.failRevoke.value = true
    await expect(disabledCase.ctx.accountAdministration.adminDisable({
      actor: await currentCall(disabledCase, disabledActor), userId: disabledTarget.userId,
      expectedRevision: 1, requestId, signal,
    })).rejects.toMatchObject({ code: 'session-revocation-incomplete', recovery: { operation: 'disable' } })

    const resetCase = await setup()
    allowAdmin(resetCase)
    const resetActor = (await resetCase.users.create()).userId
    const resetTarget = await resetCase.ctx.accountAdministration.adminCreate({
      actor: await currentCall(resetCase, resetActor), ...registration(),
    })
    resetCase.failRevoke.value = true
    await expect(resetCase.ctx.accountAdministration.adminResetPassword({
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
    await expect(ctx.accounts.register({ ...registration(), requestId: 'bad request id' as never }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(ctx.accounts.register({ ...registration(), signal: {} as never }))
      .rejects.toMatchObject({ code: 'invalid-input' })
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
