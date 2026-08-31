/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-lsp-diagnostics`.
 * @module @deepseek-ai/dsh-lsp-diagnostics/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-lsp-diagnostics'

/** Cordis companion plugin name. */
export const name = 'lsp-diagnostics-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: diagnostics provider ids and push subscriptions are private, atomically
 * updated state; the seam exposes neither an enumerable snapshot nor lifecycle events to compare
 * independently.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
