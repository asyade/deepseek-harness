/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-lsp-stdio-diagnostics`.
 * @module @deepseek-ai/dsh-lsp-stdio-diagnostics/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-lsp-stdio-diagnostics'

export const name = 'lsp-stdio-diagnostics-invariant'
export const inject = ['invariants']

/**
 * No runtime invariant: per-workspace diagnostics process liveness and document sync are internal to
 * the pooled provider; the only externally observable contract is the debounced snapshot via
 * `ctx.lspDiagnostics` and its session `lsp/diagnostics` event projection.
 */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
