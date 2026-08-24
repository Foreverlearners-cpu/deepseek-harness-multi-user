/** MySQL-backed complete authentication suite. @module @deepseek-ai/dsh-auth-starter */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AccountService } from '@deepseek-ai/dsh-account'
import * as AccountMysql from '@deepseek-ai/dsh-account-mysql'
import AuthGatewayService from '@deepseek-ai/dsh-auth-gateway'
import * as AuthJwt from '@deepseek-ai/dsh-auth-jwt'
import AuthTokenMysql from '@deepseek-ai/dsh-auth-token-mysql'
import Mysql, { type Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'
import UserCredentialMysqlService from '@deepseek-ai/dsh-user-credential-mysql'
import UserMysqlDirectory from '@deepseek-ai/dsh-user-mysql'
import {
  assertAuthenticationAssembly,
  mountAuthenticationAssembly,
  prepareAuthenticationAssembly,
  type AuthenticationAssemblyConfig,
} from './assembly.ts'

export { AUTH_PROVIDER_READINESS } from './assembly.ts'

/** Complete MySQL suite configuration. */
export interface Config extends AuthenticationAssemblyConfig {
  /** MySQL pool and database target. */
  readonly mysql: MysqlConfig
}

/** Cordis configuration schema; JWT and MySQL secrets have no production defaults. */
export const Config = z.object({
  mysql: Mysql.Config.required(),
  jwt: AuthJwt.Config.required(),
  gateway: AuthGatewayService.Config.default({}),
}) as unknown as z<Config>

/** Cordis plugin name. */
export const name = 'auth-starter'
/** The complete suite owns every service it requires. */
export const inject: readonly string[] = []

/** Mount the complete MySQL authentication suite in dependency order.
 * @param ctx - suite-owned Cordis context.
 * @param config - MySQL, JWT, and gateway deployment configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(Mysql, config.mysql)
  await ctx.plugin(UserMysqlDirectory)
  await ctx.plugin(UserCredentialMysqlService)
  await ctx.plugin(AuthTokenMysql)
  await ctx.plugin(AccountService)
  await ctx.plugin(AccountMysql)
  prepareAuthenticationAssembly(ctx, config)
  await mountAuthenticationAssembly(ctx, config)
  assertAuthenticationAssembly(ctx)
}
