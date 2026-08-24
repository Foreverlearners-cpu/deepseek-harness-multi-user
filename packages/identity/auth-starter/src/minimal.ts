/** Authentication consumers over externally supplied storage services. @module @deepseek-ai/dsh-auth-starter/minimal */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AuthGatewayService from '@deepseek-ai/dsh-auth-gateway'
import * as AuthJwt from '@deepseek-ai/dsh-auth-jwt'
import {
  AUTH_PROVIDER_READINESS,
  assertAuthenticationAssembly,
  mountAuthenticationAssembly,
  prepareAuthenticationAssembly,
  type AuthenticationAssemblyConfig,
} from './assembly.ts'

export { AUTH_PROVIDER_READINESS } from './assembly.ts'

/** Custom-provider suite configuration. */
export interface Config extends AuthenticationAssemblyConfig {}

/** Cordis configuration schema; signing material remains mandatory. */
export const Config = z.object({
  jwt: AuthJwt.Config.required(),
  gateway: AuthGatewayService.Config.default({}),
}) as unknown as z<Config>

/** Cordis plugin name. */
export const name = 'auth-starter-minimal'
/** Storage services and durable registration operations must be supplied by sibling plugins. */
export const inject = ['users', 'userCredentials', 'authTokens', 'accounts', AUTH_PROVIDER_READINESS]

/** Mount authentication consumers over injected custom Providers.
 * @param ctx - context carrying custom user, credential, token, and account services.
 * @param config - JWT and gateway deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  prepareAuthenticationAssembly(ctx, config)
  await mountAuthenticationAssembly(ctx, config)
  assertAuthenticationAssembly(ctx)
}
