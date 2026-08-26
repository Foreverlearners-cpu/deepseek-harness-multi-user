/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-team`.
 * @module @deepseek-ai/dsh-team/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-team'

/** Cordis companion plugin name. */
export const name = 'team-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('team/changed', (event) => {
    if (ctx.get('teams') === undefined) {
      fail(`team/changed for "${event.teamId}" emitted without a live teams service`)
    }
  })
  ctx.on('team/membership-changed', (event) => {
    if (ctx.get('teams') === undefined) {
      fail(`team/membership-changed for "${event.membershipId}" emitted without a live teams service`)
    }
  })
}

/** Register this package's committed-team-event lifecycle invariant. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
