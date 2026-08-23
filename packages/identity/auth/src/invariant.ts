/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-auth`.
 * @module @deepseek-ai/dsh-auth/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth'

/** Cordis companion plugin name. */
export const name = 'auth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('auth/result', (record) => {
    if (ctx.get('auth') === undefined) {
      fail(`auth/result for "${record.requestId}" emitted without a live auth service`)
    }
  })
}

/** Register this package's authentication-event lifecycle invariant. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
