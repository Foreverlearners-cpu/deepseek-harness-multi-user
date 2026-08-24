/** Shared authentication-suite assembly. */

import type { Context } from '@deepseek-ai/cordis'
import { AccountAdministrationService } from '@deepseek-ai/dsh-account'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import AuthGatewayService, { type AuthGatewayConfig } from '@deepseek-ai/dsh-auth-gateway'
import * as AuthJwt from '@deepseek-ai/dsh-auth-jwt'
import { resolveSpec as resolveJwtSpec } from '@deepseek-ai/dsh-auth-jwt'
import type { JwtAuthenticationConfig } from '@deepseek-ai/dsh-auth-jwt/types'
import * as AuthPassword from '@deepseek-ai/dsh-auth-password'

/** Configuration shared by the full and minimal suites. */
export interface AuthenticationAssemblyConfig {
  /** JWT issuer, audience, lifetimes, and explicit signing keyring. */
  readonly jwt: JwtAuthenticationConfig
  /** Browser carrier and trusted-origin policy. */
  readonly gateway?: AuthGatewayConfig
}

/** Readiness marker custom Provider bundles publish after every registration commits. */
export const AUTH_PROVIDER_READINESS = 'authProvidersReady'

/** Validate configuration and existing services before mounting child plugins.
 * @param ctx - target context.
 * @param config - authentication deployment configuration.
 */
export function prepareAuthenticationAssembly(ctx: Context, config: AuthenticationAssemblyConfig): void {
  resolveJwtSpec(config.jwt)
  for (const service of ['auth', 'authGateway', 'accountAdministration']) {
    if (ctx.get(service) !== undefined) throw new Error(`auth-starter: service "${service}" is already active`)
  }
  const accounts = ctx.get('accounts')
  if (accounts === undefined) throw new Error('auth-starter: account service is unavailable')
  accounts.registrationOperations.require()
}

/** Mount transport and account consumers over active storage services.
 * @param ctx - suite-owned context carrying user, credential, token, and account services.
 * @param config - explicit JWT and optional gateway configuration.
 */
export async function mountAuthenticationAssembly(ctx: Context, config: AuthenticationAssemblyConfig): Promise<void> {
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(AuthPassword)
  await ctx.plugin(AuthJwt, config.jwt)
  await ctx.plugin(AccountAdministrationService)
  await ctx.plugin(AuthGatewayService, config.gateway ?? {})
}

/** Reject a suite whose required Providers did not register.
 * @param ctx - assembled authentication context.
 */
export function assertAuthenticationAssembly(ctx: Context): void {
  const auth = ctx.get('auth')
  const accounts = ctx.get('accounts')
  if (auth === undefined || auth.providers.resolveEvidence('password') === undefined
    || auth.providers.resolveEvidence('bearer') === undefined) {
    throw new Error('auth-starter: required authentication Providers are unavailable')
  }
  if (accounts === undefined) throw new Error('auth-starter: account service is unavailable')
  accounts.registrationOperations.require()
}
