/** Explicit in-memory Authorization Provider for bootstrap and local profiles. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AuthorizationProvider, {
  type AuthorizationProviderEffect,
  type AuthorizationRequest,
  type PermissionDefinition,
} from '@deepseek-ai/dsh-authorization'

/** Static policy selected explicitly by composition. */
export type StaticAuthorizationMode = 'deny-all' | 'trusted-local'

/** Static Provider configuration with no implicit allow mode. */
export interface Config {
  /** Explicit default-deny or trusted local policy. */
  readonly mode: StaticAuthorizationMode
}

function isStaticAuthorizationMode(value: unknown): value is StaticAuthorizationMode {
  return value === 'deny-all' || value === 'trusted-local'
}

/** Default-deny or explicit trusted-local Provider. */
export class StaticAuthorizationProvider extends AuthorizationProvider {
  /** Composition must choose one policy mode. */
  static Config: z<Config> = z.object({
    mode: z.union(['deny-all', 'trusted-local']),
  })

  /** @param ctx - Owning Host Context. @param config - Explicit static policy. */
  constructor(ctx: Context, public config: Config) {
    super(ctx)
    if (!isStaticAuthorizationMode(config.mode)) {
      throw new TypeError('authorization-static: mode must be "deny-all" or "trusted-local"')
    }
  }

  /** @param request - Authenticated registered action. @param definition - Current permission. @returns Static effect. */
  protected evaluate(
    request: AuthorizationRequest,
    definition: PermissionDefinition,
  ): Promise<AuthorizationProviderEffect> {
    void definition
    if (this.config.mode === 'deny-all') {
      return Promise.resolve({ effect: 'deny', reason: 'provider-denied' })
    }
    if (request.call.principal.kind !== 'local') {
      return Promise.resolve({ effect: 'deny', reason: 'principal-unsupported' })
    }
    return Promise.resolve({ effect: 'allow' })
  }
}

export default StaticAuthorizationProvider
