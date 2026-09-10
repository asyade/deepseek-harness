/**
 * Diagnostics seam vocabulary: normalized diagnostic records, snapshots, and provider contracts.
 * Types only — the {@link LspDiagnosticsProviderId} brand and {@link LspError} taxonomy live in
 * `index.ts`. Positions and ranges are zero-based UTF-16, matching the LSP wire convention; the
 * model-facing tool owns any one-based presentation.
 *
 * Dedup mirrors opencode `client.ts:91-105` `dedupeDiagnostics`: merged diagnostics are keyed by
 * `JSON.stringify({ code, severity, message, source, range })` before capping. Severity follows
 * the LSP DiagnosticSeverity enum: 1 Error, 2 Warning, 3 Information, 4 Hint.
 *
 * The seam exposes no protocol types, process or document controls, or generic JSON-RPC escape
 * hatch — only the workspace-scoped snapshot query and push observation.
 * @module @deepseek-ai/dsh-lsp-diagnostics/types
 */

import type { LspDiagnosticsProviderId } from './brand.ts'

/** A zero-based UTF-16 cursor coordinate, matching the LSP wire convention. */
export interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}

/** A zero-based UTF-16 half-open range `[start, end)`. */
export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

/**
 * One normalized diagnostic. The `range` is zero-based UTF-16; `severity` uses the LSP
 * DiagnosticSeverity codes 1|2|3|4 (Error, Warning, Info, Hint). `code` and `source` are opaque
 * provider metadata; `message` is human-readable. Dedup is by
 * `JSON.stringify({ code, severity, message, source, range })` (opencode `client.ts:91-105`).
 */
export interface LspDiagnostic {
  /** The document URI (`file:` or otherwise), verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
  /** LSP DiagnosticSeverity: 1 Error, 2 Warning, 3 Information, 4 Hint. */
  readonly severity: 1 | 2 | 3 | 4
  /** Optional diagnostic code (string or number) from the language server. */
  readonly code?: string | number
  /** Optional source (e.g. `typescript`, `rust-analyzer`). */
  readonly source?: string
  /** Human-readable diagnostic message. */
  readonly message: string
}

/**
 * A per-workspace diagnostics snapshot. `byFile` is a read-only map from normalized file URI or
 * file path to the diagnostics for that file (empty map means no diagnostics). `at` is a
 * monotonic timestamp (e.g. `Date.now()`) marking snapshot commit time. `workspaceRoot` is the
 * canonical workspace root the snapshot belongs to.
 */
export interface LspDiagnosticsSnapshot {
  /** Canonical workspace root this snapshot was collected for. */
  readonly workspaceRoot: string
  /** Diagnostics grouped by file (key is file URI or absolute path, verbatim from provider). */
  readonly byFile: ReadonlyMap<string, readonly LspDiagnostic[]>
  /** Millisecond timestamp of snapshot creation/commit. */
  readonly at: number
}

/**
 * The request for a diagnostics snapshot. Every query is workspace-scoped; `filePath` optionally
 * narrows to a single file (provider may still return workspace-wide data and the seam filters).
 */
export interface LspDiagnosticsRequest {
  /** The workspace root to query (relative or absolute; the seam canonicalizes it). */
  readonly workspaceRoot: string
  /** Optional file path to narrow the snapshot to one file (relative to workspaceRoot or absolute). */
  readonly filePath?: string
}

/**
 * A diagnostics backend registered on `ctx.lspDiagnostics`. Each provider owns a stable
 * {@link LspDiagnosticsProviderId}. Diagnostics are workspace-scoped, not per-extension;
 * selection is by canonical `workspaceRoot` (via `canonicalizeWorkspace` copied from
 * `packages/lsp/lsp-stdio/src/host.ts:32-59`) rather than extension mapping.
 *
 * Merge/dedup and caps mirror opencode: dedup by
 * `JSON.stringify({ code, severity, message, source, range })` (`client.ts:91-105`), then
 * `MAX_PER_FILE=20` and cross-file `5` like `diagnostic.ts:1` / `write.ts:18`; the seam itself
 * does not enforce caps — providers do — but consumers should treat results as already capped.
 */
export interface LspDiagnosticsProvider {
  /** Stable provider identity, reserved atomically at registration. */
  readonly id: LspDiagnosticsProviderId
  /**
   * Pull a fresh snapshot for a workspace. The seam has already canonicalized `workspaceRoot`.
   * @param request - workspace-scoped diagnostics request.
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized snapshot for that workspace.
   */
  diagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsSnapshot>
  /**
   * Subscribe to fresh push snapshots (debounced, per-workspace). Each emission is a full snapshot
   * for one workspace (not an incremental patch). The provider may coalesce rapid changes.
   * @param listener - called for each fresh snapshot.
   * @returns a synchronous disposer removing the listener.
   */
  onDiagnostics(listener: (snapshot: LspDiagnosticsSnapshot) => void): () => void
}

/**
 * The diagnostics capability seam (`ctx.lspDiagnostics`). Owns provider registration, workspace-
 * canonical selection, normalized snapshot query, and push observation. Exposes no protocol escape
 * hatch and no extension map.
 */
export interface LspDiagnosticsService {
  /**
   * Register a diagnostics provider, atomically reserving its id. Any invalid input or duplicate id
   * publishes nothing and throws `LspError` (`LSP_INVALID_PROVIDER` / `LSP_CONFLICT`); the returned
   * disposer releases the reservation together with any workspace routing and push forwarding.
   * Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the id and provider subscription.
   */
  registerProvider(provider: LspDiagnosticsProvider): () => void
  /**
   * Select the provider and pull one snapshot for the workspace. The seam canonicalizes
   * `workspaceRoot`; no match or empty workspace throws `LspError` `LSP_UNAVAILABLE` /
   * `LSP_INVALID_PROVIDER`.
   * @param request - workspace-scoped query (the seam canonicalizes `workspaceRoot`).
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized snapshot.
   */
  diagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsSnapshot>
  /**
   * Subscribe to fresh push snapshots from the provider (debounced, per-workspace). Each emission
   * is a full snapshot. Returns a disposer removing the listener.
   * @param listener - called for each fresh snapshot.
   * @returns a synchronous disposer.
   */
  onDiagnostics(listener: (snapshot: LspDiagnosticsSnapshot) => void): () => void
}
