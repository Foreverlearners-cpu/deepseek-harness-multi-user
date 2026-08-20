import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationProvider, {
  authenticationMethod,
  authenticationRequestId,
  localPrincipalId,
  membershipId,
  serviceAccountId,
  tenantId,
  userId,
  type AuthenticatedCall,
  type AuthenticationAttempt,
  type VerifiedAuthentication,
} from '@deepseek-ai/dsh-authentication'
import {
  permissionCode,
  type PermissionDefinition,
} from '@deepseek-ai/dsh-authorization'
import StaticAuthorizationProvider, {
  type StaticAuthorizationMode,
} from '../src/index.ts'

class FixtureAuthentication extends AuthenticationProvider {
  constructor(ctx: Context, private readonly verified: VerifiedAuthentication) {
    super(ctx)
  }

  protected verify(_attempt: AuthenticationAttempt): Promise<VerifiedAuthentication> {
    return Promise.resolve(this.verified)
  }
}

const PERMISSION = permissionCode('fixture:read')
const DEFINITION: PermissionDefinition = {
  code: PERMISSION,
  owner: '@fixture/domain',
  description: 'Read fixture metadata.',
  disclosure: 'metadata',
}

function verified(kind: 'local' | 'user' | 'service-account'): VerifiedAuthentication {
  const principal = kind === 'local'
    ? { kind, id: localPrincipalId('local-user') } as const
    : kind === 'user'
      ? { kind, id: userId('user-1') } as const
      : { kind, id: serviceAccountId('service-1') } as const
  return {
    principal,
    method: authenticationMethod('fixture'),
    scope: {
      kind: 'tenant',
      tenantId: tenantId('tenant-1'),
      membershipId: membershipId('membership-1'),
    },
  }
}

async function boot(mode: StaticAuthorizationMode, kind: 'local' | 'user' | 'service-account' = 'local'):
Promise<{ ctx: Context; call: AuthenticatedCall }> {
  const ctx = new Context()
  await ctx.plugin(FixtureAuthentication, verified(kind))
  await ctx.plugin(StaticAuthorizationProvider, { mode })
  ctx.authorization.permissions.register(DEFINITION)
  const call = await ctx.authentication.authenticate({
    requestId: authenticationRequestId(`${kind}-request`),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal: new AbortController().signal,
  })
  return { ctx, call }
}

describe('StaticAuthorizationProvider', () => {
  it('denies every registered action in deny-all mode', async () => {
    const { ctx, call } = await boot('deny-all')
    await expect(ctx.authorization.require({ call, permission: PERMISSION })).rejects.toMatchObject({
      reason: 'provider-denied',
      publicError: { code: 'FORBIDDEN' },
    })
  })

  it('allows only an explicitly authenticated local principal in trusted-local mode', async () => {
    const local = await boot('trusted-local', 'local')
    await expect(local.ctx.authorization.require({ call: local.call, permission: PERMISSION }))
      .resolves.toMatchObject({ effect: 'allow' })

    for (const kind of ['user', 'service-account'] as const) {
      const fixture = await boot('trusted-local', kind)
      await expect(fixture.ctx.authorization.require({
        call: fixture.call,
        permission: PERMISSION,
      })).rejects.toMatchObject({ reason: 'principal-unsupported' })
    }
  })

  it.each(['allow-all', '', 'trusted'])(
    'fails activation for unsupported mode %j',
    async (mode) => {
      const ctx = new Context()
      await expect(ctx.plugin(StaticAuthorizationProvider, { mode } as never).await()).rejects.toThrow(TypeError)
      expect(ctx.get('authorization')).toBeUndefined()
    },
  )
})
