/**
 * Local fallback types for the diagnostics seam (ctx.lspDiagnostics).
 * If Phase 1 has landed, these must stay compatible with `packages/lsp/lsp-diagnostics/src/types.ts`.
 * This file is the dependency note: the stdio provider targets the seam's contract without
 * hard-importing it until the package exists, so type-checking this package alone does not require
 * the seam's build artifacts. Replace imports with `@deepseek-ai/dsh-lsp-diagnostics` when Phase 1 merges.
 * @module @deepseek-ai/dsh-lsp-stdio-diagnostics/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque provider identity for diagnostics (atomic reserve/release like LspProviderId). */
export type LspDiagnosticsProviderId = Branded<'LspDiagnosticsProviderId'>

/**
 * Brand a string as an {@link LspDiagnosticsProviderId}.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function LspDiagnosticsProviderId(id: string): LspDiagnosticsProviderId {
  return id as LspDiagnosticsProviderId
}

/** Zero-based UTF-16 position (mirrors lsp seam). */
export interface LspPosition {
  readonly line: number
  readonly character: number
}

/** Zero-based UTF-16 range. */
export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

/** One normalized diagnostic. */
export interface LspDiagnostic {
  readonly uri: string
  readonly range: LspRange
  readonly severity?: 1 | 2 | 3 | 4
  readonly code?: string | number
  readonly source?: string
  readonly message: string
}

/** A debounced snapshot: workspaceRoot + per-file diagnostics, stamped at merge time. */
export interface LspDiagnosticsSnapshot {
  readonly workspaceRoot: string
  readonly byFile: ReadonlyMap<string, readonly LspDiagnostic[]>
  readonly at: number
}

/** Request to the seam/provider; filePath absent means workspace-wide capped snapshot. */
export interface LspDiagnosticsRequest {
  readonly workspaceRoot: string
  readonly filePath?: string
}

/** Diagnostics provider contract (workspace-scoped, not per-extension). */
export interface LspDiagnosticsProvider {
  readonly id: LspDiagnosticsProviderId
  /** Extension→language map used to sync documents with the correct languageId. */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  diagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsSnapshot>
  onDiagnostics(listener: (snapshot: LspDiagnosticsSnapshot) => void): () => void
}

/** Diagnostics seam service (ctx.lspDiagnostics). */
export interface LspDiagnosticsService {
  registerProvider(provider: LspDiagnosticsProvider): () => void
  diagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsSnapshot>
  onDiagnostics(listener: (snapshot: LspDiagnosticsSnapshot) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    lspDiagnostics?: LspDiagnosticsService
  }
}
