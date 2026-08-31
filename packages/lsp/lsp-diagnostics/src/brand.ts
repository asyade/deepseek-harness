/**
 * dsh-lsp-diagnostics's owned branded id: {@link LspDiagnosticsProviderId}, the opaque identity a
 * diagnostics provider reserves on `ctx.lspDiagnostics`. The `Branded<B>` primitive lives in
 * `@deepseek-ai/dsh-brand`; keeping the type and its factory together here lets `index.ts`
 * re-export both under one name.
 * @module @deepseek-ai/dsh-lsp-diagnostics/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque diagnostics provider identity, reserved atomically at registration. */
export type LspDiagnosticsProviderId = Branded<'LspDiagnosticsProviderId'>

/**
 * Brand a string as an {@link LspDiagnosticsProviderId}. No validation — the registry rejects an
 * empty id at registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function LspDiagnosticsProviderId(id: string): LspDiagnosticsProviderId {
  return id as LspDiagnosticsProviderId
}
