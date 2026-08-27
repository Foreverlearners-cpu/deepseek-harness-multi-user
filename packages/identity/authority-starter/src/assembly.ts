/** Shared authorization-suite assembly. */

import type { Context } from '@deepseek-ai/cordis'
import AccountAuthority from '@deepseek-ai/dsh-account-authority'
import AuthRbac from '@deepseek-ai/dsh-auth-rbac'
import AuthRbacMysql from '@deepseek-ai/dsh-auth-rbac-mysql'
import Authority from '@deepseek-ai/dsh-authority'
import AuthorityAcl from '@deepseek-ai/dsh-authority-acl'
import AuthorityAclMysql from '@deepseek-ai/dsh-authority-acl-mysql'
import TeamMysqlDirectory from '@deepseek-ai/dsh-team-mysql'
import TenantAuthority from '@deepseek-ai/dsh-tenant-authority'
import TenantMysqlDirectory from '@deepseek-ai/dsh-tenant-mysql'

/** Readiness marker custom Provider bundles publish after sources register. */
export const AUTHORITY_PROVIDER_READINESS = 'authorityProvidersReady'

const FULL_REQUIRED = ['mysql', 'auth', 'accountAdministration'] as const
const MINIMAL_REQUIRED = [
  'auth',
  'accountAdministration',
  'tenants',
  'teams',
  'authority',
  'authRbac',
  'authorityAcl',
  AUTHORITY_PROVIDER_READINESS,
] as const
const FULL_OWNED = [
  'tenants',
  'teams',
  'authority',
  'authRbac',
  'authorityAcl',
  'authRbacMysql',
  'authorityAclMysql',
  'tenantAuthority',
  'accountAuthority',
] as const
const CONSUMER_OWNED = ['tenantAuthority', 'accountAuthority'] as const

/** Plugins that persist tenant, team, role, and object state in MySQL. */
export const AUTHORITY_MYSQL_PLUGINS = [
  TenantMysqlDirectory,
  TeamMysqlDirectory,
  Authority,
  AuthRbac,
  AuthRbacMysql,
  AuthorityAcl,
  AuthorityAclMysql,
] as const

/** Product decide entry and account-administration wiring. */
export const AUTHORITY_CONSUMER_PLUGINS = [TenantAuthority, AccountAuthority] as const

function missing(name: string): Error {
  return new Error(`authority-starter: service "${name}" is unavailable`)
}

function conflict(name: string): Error {
  return new Error(`authority-starter: service "${name}" is already active`)
}

function requirePresent(ctx: Context, names: readonly string[]): void {
  for (const name of names) {
    if (ctx.get(name) === undefined) throw missing(name)
  }
}

function requireAbsent(ctx: Context, names: readonly string[]): void {
  for (const name of names) {
    if (ctx.get(name) !== undefined) throw conflict(name)
  }
}

/** Reject missing injected services or an already-assembled authority tree.
 * @param ctx - target context.
 * @param suite - complete MySQL tree or consumer-only mount.
 */
export function prepareAuthorityAssembly(ctx: Context, suite: 'full' | 'minimal'): void {
  if (suite === 'full') {
    requirePresent(ctx, FULL_REQUIRED)
    requireAbsent(ctx, FULL_OWNED)
    return
  }
  requirePresent(ctx, MINIMAL_REQUIRED)
  requireAbsent(ctx, CONSUMER_OWNED)
}

/** Mount the MySQL-backed authority tree in dependency order.
 * @param ctx - suite-owned context carrying mysql, auth, and accountAdministration.
 */
export async function mountAuthorityMysqlTree(ctx: Context): Promise<void> {
  for (const plugin of AUTHORITY_MYSQL_PLUGINS) await ctx.plugin(plugin)
}

/** Mount the decide entry and account authorizer.
 * @param ctx - context carrying auth, authority, directories, and accountAdministration.
 */
export async function mountAuthorityConsumers(ctx: Context): Promise<void> {
  for (const plugin of AUTHORITY_CONSUMER_PLUGINS) await ctx.plugin(plugin)
}

/** Reject a suite whose required services did not register.
 * @param ctx - assembled authorization context.
 * @param suite - complete MySQL tree or consumer-only mount.
 */
export function assertAuthorityAssembly(ctx: Context, suite: 'full' | 'minimal'): void {
  requirePresent(ctx, suite === 'full' ? FULL_OWNED : CONSUMER_OWNED)
}
