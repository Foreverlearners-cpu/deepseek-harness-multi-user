/** Runtime relation checks for `@deepseek-ai/dsh-authorization`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-authorization'

/** Cordis companion plugin name. */
export const name = 'authorization-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/** Every invalidation event must publish the service's current, changed version. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('authorization/invalidated', (next, previous) => {
    if (next !== ctx.authorization.policyVersion || next === previous) {
      fail('authorization invalidation must publish the changed current policy version')
    }
  })
}, { inject: ['authorization'] })

/** @param ctx - Context carrying authorization and invariant services. @returns Registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
