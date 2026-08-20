import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationProvider, {
  authenticationMethod,
  authenticationRequestId,
  localPrincipalId,
  membershipId,
  tenantId,
  type AuthenticatedCall,
  type AuthenticationAttempt,
  type VerifiedAuthentication,
} from '@deepseek-ai/dsh-authentication'
import AuthorizationProvider, {
  AuthorizationDeniedError,
  permissionCode,
  type AuthorizationProviderEffect,
  type AuthorizationRequest,
  type PermissionDefinition,
  type PolicyVersion,
} from '../src/index.ts'

class FixtureAuthentication extends AuthenticationProvider {
  constructor(ctx: Context, private readonly verified: VerifiedAuthentication) {
    super(ctx)
  }

  protected verify(_attempt: AuthenticationAttempt): Promise<VerifiedAuthentication> {
    return Promise.resolve(this.verified)
  }
}

interface AuthorizationConfig {
  readonly evaluate: (
    request: AuthorizationRequest,
    definition: PermissionDefinition,
  ) => AuthorizationProviderEffect | Promise<AuthorizationProviderEffect>
}

class FixtureAuthorization extends AuthorizationProvider {
  constructor(ctx: Context, private readonly config: AuthorizationConfig) {
    super(ctx)
  }

  invalidate(): PolicyVersion {
    return this.invalidatePolicy()
  }

  protected evaluate(
    request: AuthorizationRequest,
    definition: PermissionDefinition,
  ): Promise<AuthorizationProviderEffect> {
    return Promise.resolve(this.config.evaluate(request, definition))
  }
}

const READ = permissionCode('fixture:read')
const WRITE = permissionCode('fixture:write')
const READ_DEFINITION: PermissionDefinition = {
  code: READ,
  owner: '@fixture/domain',
  description: 'Read fixture metadata.',
  disclosure: 'metadata',
}

function identity(expiresAt?: number): VerifiedAuthentication {
  return {
    principal: { kind: 'local', id: localPrincipalId('local-user') },
    method: authenticationMethod('fixture'),
    scope: {
      kind: 'tenant',
      tenantId: tenantId('tenant-1'),
      membershipId: membershipId('membership-1'),
    },
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

async function boot(options: {
  readonly verified?: VerifiedAuthentication
  readonly evaluate?: AuthorizationConfig['evaluate']
  readonly signal?: AbortSignal
} = {}): Promise<{
  ctx: Context
  call: AuthenticatedCall
  authorization: FixtureAuthorization
  authenticationFiber: Awaited<ReturnType<Context['plugin']>>
  authorizationFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  const authenticationFiber = ctx.plugin(FixtureAuthentication, options.verified ?? identity())
  await authenticationFiber
  const authorizationFiber = ctx.plugin(FixtureAuthorization, {
    evaluate: options.evaluate ?? (() => ({ effect: 'allow' })),
  })
  await authorizationFiber
  const call = await ctx.authentication.authenticate({
    requestId: authenticationRequestId('authorization-test'),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal: options.signal ?? new AbortController().signal,
  })
  return {
    ctx,
    call,
    authorization: ctx.authorization as FixtureAuthorization,
    authenticationFiber,
    authorizationFiber,
  }
}

describe('permissionCode', () => {
  it.each(['fixture:read', 'plugin:metadata-read', 'settings:user-write'])(
    'brands %s',
    (value) => {
      expect(permissionCode(value)).toBe(value)
    },
  )

  it.each(['', 'read', 'Fixture:read', 'fixture:', ':read', 'fixture:read:all', 'fixture:read_all'])(
    'rejects %j',
    (value) => {
      expect(() => permissionCode(value)).toThrow(TypeError)
    },
  )
})

describe('AuthorizationProvider decisions', () => {
  it('allows a registered action and emits a frozen safe decision record', async () => {
    const { ctx, call, authorization } = await boot()
    const records: unknown[] = []
    ctx.on('authorization/decision', record => records.push(record))
    authorization.permissions.register(READ_DEFINITION)

    const decision = await authorization.require({ call, permission: READ })

    expect(decision).toMatchObject({ effect: 'allow', obligations: [] })
    expect(authorization.isCurrent(decision.policyVersion)).toBe(true)
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.obligations)).toBe(true)
    expect(records).toEqual([{
      requestId: 'authorization-test',
      channel: 'in-process',
      principalKind: 'local',
      permission: 'fixture:read',
      effect: 'allow',
      policyVersion: decision.policyVersion,
    }])
    expect(Object.isFrozen(records[0])).toBe(true)
  })

  it('denies a structural call before invoking the Provider', async () => {
    const evaluate = vi.fn(() => ({ effect: 'allow' as const }))
    const { call, authorization } = await boot({ evaluate })
    authorization.permissions.register(READ_DEFINITION)
    const forged = { ...call } as AuthenticatedCall

    const decision = await authorization.decide({ call: forged, permission: READ })

    expect(decision).toMatchObject({
      effect: 'deny',
      reason: 'unauthenticated',
      publicError: { code: 'UNAUTHENTICATED' },
    })
    expect(evaluate).not.toHaveBeenCalled()
    const error = await authorization.require({ call: forged, permission: READ }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(AuthorizationDeniedError)
    expect(error).toMatchObject({
      code: 'AUTHORIZATION_DENIED',
      requestId: undefined,
      permission: 'fixture:read',
      reason: 'unauthenticated',
      publicError: { code: 'UNAUTHENTICATED' },
    })
  })

  it('denies a call after its issuing Authentication Provider is disposed', async () => {
    const { call, authorization, authenticationFiber } = await boot()
    authorization.permissions.register(READ_DEFINITION)
    await authenticationFiber.dispose()

    await expect(authorization.require({ call, permission: READ })).rejects.toMatchObject({
      reason: 'unauthenticated',
      publicError: { code: 'UNAUTHENTICATED' },
    })
  })

  it('denies expired credentials before consulting the permission catalog', async () => {
    const evaluate = vi.fn(() => ({ effect: 'allow' as const }))
    const { call, authorization } = await boot({
      verified: identity(Date.now() - 1),
      evaluate,
    })
    authorization.permissions.register(READ_DEFINITION)

    await expect(authorization.require({ call, permission: READ })).rejects.toMatchObject({
      requestId: 'authorization-test',
      reason: 'credential-expired',
      publicError: { code: 'UNAUTHENTICATED' },
    })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('denies an unregistered permission without invoking the Provider', async () => {
    const evaluate = vi.fn(() => ({ effect: 'allow' as const }))
    const { call, authorization } = await boot({ evaluate })
    const decision = await authorization.decide({ call, permission: WRITE })

    expect(decision).toMatchObject({
      effect: 'deny',
      reason: 'permission-unregistered',
      publicError: { code: 'FORBIDDEN' },
    })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('normalizes a Provider denial and its immutable obligations', async () => {
    const obligation = Object.freeze({ kind: 'fixture-mask', field: 'moduleName' }) as never
    const { call, authorization } = await boot({
      evaluate: () => ({
        effect: 'deny',
        reason: 'provider-denied',
        obligations: [obligation],
      }),
    })
    authorization.permissions.register(READ_DEFINITION)

    const decision = await authorization.decide({ call, permission: READ })
    expect(decision).toMatchObject({
      effect: 'deny',
      reason: 'provider-denied',
      publicError: { code: 'FORBIDDEN' },
      obligations: [obligation],
    })
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.obligations)).toBe(true)
  })

  it('contains a Provider failure as a default denial', async () => {
    const failure = new Error('policy backend unavailable')
    const { ctx, call, authorization } = await boot({
      evaluate: () => { throw failure },
    })
    const warnings: unknown[] = []
    ctx.logger.warn = ((value: unknown) => { warnings.push(value) }) as typeof ctx.logger.warn
    authorization.permissions.register(READ_DEFINITION)

    const decision = await authorization.decide({ call, permission: READ })
    expect(decision).toMatchObject({ effect: 'deny', reason: 'provider-failed' })
    expect(warnings).toEqual([
      'authorization: Provider failed while deciding %s',
      failure,
    ])
  })

  it('rejects a decision when policy changes while its Provider is evaluating', async () => {
    let start!: () => void
    let finish!: (effect: AuthorizationProviderEffect) => void
    const started = new Promise<void>((resolve) => { start = resolve })
    const pendingEffect = new Promise<AuthorizationProviderEffect>((resolve) => { finish = resolve })
    const { call, authorization } = await boot({
      evaluate: () => {
        start()
        return pendingEffect
      },
    })
    authorization.permissions.register(READ_DEFINITION)
    const before = authorization.policyVersion

    const pending = authorization.decide({ call, permission: READ })
    await started
    const after = authorization.invalidate()
    finish({ effect: 'allow' })

    await expect(pending).resolves.toMatchObject({ effect: 'deny', reason: 'policy-stale' })
    expect(after).not.toBe(before)
    expect(authorization.isCurrent(before)).toBe(false)
    expect(authorization.isCurrent(after)).toBe(true)
  })

  it('rejects an allow decision that becomes stale before consumption', async () => {
    const { call, authorization } = await boot()
    authorization.permissions.register(READ_DEFINITION)
    const decision = await authorization.require({ call, permission: READ })
    authorization.invalidate()

    expect(() => {
      authorization.assertCurrent({ call, permission: READ }, decision)
    }).toThrow(AuthorizationDeniedError)
    expect(() => {
      authorization.assertCurrent({ call, permission: READ }, decision)
    })
      .toThrow(/authorization denied for fixture:read/)
  })

  it('rechecks credential expiry when an allow decision is consumed', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const { call, authorization } = await boot({ verified: identity(now + 100) })
      authorization.permissions.register(READ_DEFINITION)
      const decision = await authorization.require({ call, permission: READ })
      clock.mockReturnValue(now + 101)

      expect(() => {
        authorization.assertCurrent({ call, permission: READ }, decision)
      }).toThrow(AuthorizationDeniedError)
      expect(() => {
        authorization.assertCurrent({ call, permission: READ }, decision)
      })
        .toThrow(/authorization denied for fixture:read/)
    } finally {
      clock.mockRestore()
    }
  })

  it('aborts an active lease when its policy version is invalidated', async () => {
    const { call, authorization } = await boot()
    authorization.permissions.register(READ_DEFINITION)
    const request = { call, permission: READ }
    const decision = await authorization.require(request)
    const lease = authorization.openLease(request, decision)

    authorization.invalidate()

    expect(lease.signal.aborted).toBe(true)
    expect(lease.signal.reason).toMatchObject({
      reason: 'policy-stale',
      publicError: { code: 'FORBIDDEN' },
    })
  })

  it('aborts an active lease when its credential expires', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-01-01T00:00:00.000Z')
      vi.setSystemTime(now)
      const { call, authorization } = await boot({
        verified: identity(now.getTime() + 100),
      })
      authorization.permissions.register(READ_DEFINITION)
      const request = { call, permission: READ }
      const decision = await authorization.require(request)
      const lease = authorization.openLease(request, decision)

      vi.advanceTimersByTime(100)

      expect(lease.signal.aborted).toBe(true)
      expect(lease.signal.reason).toMatchObject({
        reason: 'credential-expired',
        publicError: { code: 'UNAUTHENTICATED' },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows call cancellation and stops observing after release', async () => {
    const callAbort = new AbortController()
    const { call, authorization } = await boot({ signal: callAbort.signal })
    authorization.permissions.register(READ_DEFINITION)
    const request = { call, permission: READ }
    const decision = await authorization.require(request)
    const cancelled = authorization.openLease(request, decision)
    const released = authorization.openLease(request, decision)
    released.release()
    const reason = new Error('request cancelled')

    callAbort.abort(reason)

    expect(cancelled.signal.aborted).toBe(true)
    expect(cancelled.signal.reason).toBe(reason)
    authorization.invalidate()
    expect(released.signal.aborted).toBe(false)
  })

  it('aborts active leases when the Authorization Provider is disposed', async () => {
    const { call, authorization, authorizationFiber } = await boot()
    authorization.permissions.register(READ_DEFINITION)
    const request = { call, permission: READ }
    const decision = await authorization.require(request)
    const lease = authorization.openLease(request, decision)

    await authorizationFiber.dispose()

    expect(lease.signal.aborted).toBe(true)
    expect(lease.signal.reason).toMatchObject({ reason: 'policy-stale' })
  })
})

describe('permission catalog lifecycle', () => {
  it('normalizes, lists, resolves, disposes, and invalidates definitions', async () => {
    const { ctx, authorization } = await boot()
    const changes: Array<[PolicyVersion, PolicyVersion]> = []
    ctx.on('authorization/invalidated', (next, previous) => changes.push([next, previous]))
    const before = authorization.policyVersion
    const dispose = authorization.permissions.register(READ_DEFINITION)

    expect(authorization.permissions.get(READ)).toEqual(READ_DEFINITION)
    expect(authorization.permissions.get(READ)).not.toBe(READ_DEFINITION)
    expect(authorization.permissions.list()).toEqual([READ_DEFINITION])
    expect(Object.isFrozen(authorization.permissions.get(READ))).toBe(true)
    expect(changes).toHaveLength(1)
    expect(changes[0]![1]).toBe(before)

    await dispose()
    expect(authorization.permissions.get(READ)).toBeUndefined()
    expect(authorization.permissions.list()).toEqual([])
    expect(changes).toHaveLength(2)
    expect(changes[1]![1]).toBe(changes[0]![0])
  })

  it('ties a definition to the registering plugin fiber', async () => {
    const { ctx, authorization } = await boot()
    const fiber = ctx.plugin({
      inject: ['authorization'],
      apply(child: Context) {
        child.authorization.permissions.register(READ_DEFINITION)
      },
    })
    await fiber
    expect(authorization.permissions.get(READ)).toBeDefined()

    await fiber.dispose()
    expect(authorization.permissions.get(READ)).toBeUndefined()
  })

  it('rejects duplicate active permission owners without replacing the winner', async () => {
    const { authorization } = await boot()
    authorization.permissions.register(READ_DEFINITION)

    expect(() => authorization.permissions.register({
      ...READ_DEFINITION,
      owner: '@fixture/other',
    })).toThrow('already has an active owner')
    expect(authorization.permissions.get(READ)?.owner).toBe('@fixture/domain')
  })

  it.each([
    [{ ...READ_DEFINITION, owner: 'Not A Package' }, 'owner'],
    [{ ...READ_DEFINITION, description: '   ' }, 'description'],
    [{ ...READ_DEFINITION, disclosure: 'private' as 'metadata' }, 'disclosure'],
  ])('rejects an invalid permission definition ($#)', async (definition, _subject) => {
    const { authorization } = await boot()
    expect(() => authorization.permissions.register(definition)).toThrow(TypeError)
    expect(authorization.permissions.list()).toEqual([])
  })

  it('retains a declared domain resource kind in the immutable directory', async () => {
    const { authorization } = await boot()
    const definition = {
      ...READ_DEFINITION,
      resourceKind: 'fixture' as never,
    }
    authorization.permissions.register(definition)
    expect(authorization.permissions.get(READ)).toMatchObject({ resourceKind: 'fixture' })
  })
})
