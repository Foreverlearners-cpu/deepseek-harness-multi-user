/** Package-owned invariant companion for `@deepseek-ai/dsh-cdc-elasticsearch`. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-cdc-elasticsearch'
/** Cordis companion plugin name. */
export const name = 'cdc-elasticsearch-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']
/** No runtime invariant: the Kafka offset and Elasticsearch projection live in external systems. */
const install: InvariantInstaller = () => {}
/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
