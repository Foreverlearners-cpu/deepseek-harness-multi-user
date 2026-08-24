/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-search-projection-elasticsearch'

/** Cordis companion plugin name. */
export const name = 'session-search-projection-elasticsearch-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

// Kafka offsets and Elasticsearch versions own the mutable external relation.
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant companion.
 * @param ctx - Context carrying the invariant registry.
 * @returns Registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
