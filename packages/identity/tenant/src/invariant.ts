/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tenant`.
 * @module @deepseek-ai/dsh-tenant/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tenant'

/** Cordis companion plugin name. */
export const name = 'tenant-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('tenant/changed', (event) => {
    if (ctx.get('tenants') === undefined) {
      fail(`tenant/changed for "${event.tenantId}" emitted without a live tenants service`)
    }
  })
  ctx.on('tenant/membership-changed', (event) => {
    if (ctx.get('tenants') === undefined) {
      fail(`tenant/membership-changed for "${event.membershipId}" emitted without a live tenants service`)
    }
  })
}

/** Register this package's committed-tenant-event lifecycle invariant. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
