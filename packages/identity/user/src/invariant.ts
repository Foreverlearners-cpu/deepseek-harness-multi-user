/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-user`.
 * @module @deepseek-ai/dsh-user/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-user'

/** Cordis companion plugin name. */
export const name = 'user-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('user/changed', (event) => {
    if (ctx.get('users') === undefined) {
      fail(`user/changed for "${event.userId}" emitted without a live users service`)
    }
  })
}

/** Register this package's committed-user-event lifecycle invariant. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
