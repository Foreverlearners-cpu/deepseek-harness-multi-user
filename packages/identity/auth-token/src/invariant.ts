/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-auth-token`.
 * @module @deepseek-ai/dsh-auth-token/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-token'

/** Cordis companion plugin name. */
export const name = 'auth-token-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('auth-token/changed', (event) => {
    if (ctx.get('authTokens') === undefined) {
      fail(`auth-token/changed for "${event.tokenFamilyId}" emitted without a live authTokens service`)
    }
  })
}

/** Register this package's committed-token-event lifecycle invariant. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
