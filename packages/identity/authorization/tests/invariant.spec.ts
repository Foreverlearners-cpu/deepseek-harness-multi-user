import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import AuthorizationProvider, {
  permissionCode,
  type AuthorizationProviderEffect,
  type AuthorizationRequest,
  type PermissionDefinition,
  type PolicyVersion,
} from '../src/index.ts'
import * as AuthorizationInvariant from '../src/invariant.ts'

class FixtureAuthorization extends AuthorizationProvider {
  protected evaluate(
    _request: AuthorizationRequest,
    _definition: PermissionDefinition,
  ): Promise<AuthorizationProviderEffect> {
    return Promise.resolve({ effect: 'allow' })
  }

  invalidate(): PolicyVersion {
    return this.invalidatePolicy()
  }
}

describe('authorization invariant companion', () => {
  it('accepts committed invalidations and rejects a forged unchanged version', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(FixtureAuthorization)
    await ctx.plugin(AuthorizationInvariant)
    const authorization = ctx.authorization as FixtureAuthorization
    expect(() => authorization.invalidate()).not.toThrow()

    expect(() => {
      ctx.emit('authorization/invalidated', authorization.policyVersion, authorization.policyVersion)
    }).toThrow(InvariantError)
  })

  it('observes catalog-driven invalidation and releases registration on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(FixtureAuthorization)
    const fiber = ctx.plugin(AuthorizationInvariant)
    await fiber
    const code = permissionCode('fixture:read')
    expect(() => ctx.authorization.permissions.register({
      code,
      owner: '@fixture/domain',
      description: 'Read fixture metadata.',
      disclosure: 'metadata',
    })).not.toThrow()

    await fiber.dispose()
    await expect(ctx.plugin(AuthorizationInvariant).await()).resolves.toBeDefined()
  })
})
