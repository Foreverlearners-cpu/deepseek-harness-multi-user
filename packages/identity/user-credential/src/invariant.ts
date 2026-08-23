/** Package-owned invariant companion for `@deepseek-ai/dsh-user-credential`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-credential'

/** Cordis companion plugin name. */
export const name = 'user-credential-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('user-credential/changed', (event) => {
    if (ctx.get('userCredentials') === undefined) fail(`user-credential/changed for "${event.userId}" emitted without a live userCredentials service`)
  })
}

/** Register this package's committed-credential-event lifecycle invariant. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
