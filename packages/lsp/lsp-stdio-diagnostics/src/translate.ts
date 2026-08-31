/**
 * Pure translation for diagnostics: position encoding, sync-kind, dedupe, caps, and normalization.
 * @module @deepseek-ai/dsh-lsp-stdio-diagnostics/translate
 */

import type { LspDiagnostic, LspRange } from './types.ts'
import type { WireDiagnostic, WireRange, WireServerCapabilities, WireTextDocumentSyncKind } from './protocol.ts'

/** Largest number of diagnostics retained per file (mirrors opencode diagnostic.ts:20). */
export const MAX_PER_FILE = 20

/** Default cap on workspace-wide snapshot files (mirrors opencode write.ts MAX_PROJECT_DIAGNOSTICS_FILES=5). */
export const MAX_FILES_PER_SNAPSHOT = 5

/**
 * Negotiate the position encoding. Omitted defaults to utf-16; any other value is unsupported.
 * @param encoding - server's advertised positionEncoding.
 * @returns 'utf-16'.
 * @throws Error for non-utf-16.
 */
export function negotiatePositionEncoding(encoding: string | undefined): 'utf-16' {
  if (encoding === undefined || encoding === 'utf-16') return 'utf-16'
  throw new Error(`server negotiated unsupported position encoding "${encoding}"; this host requires utf-16`)
}

/**
 * Whether a textDocumentSync value permits persistent open/close.
 * @param sync - server's textDocumentSync capability.
 * @returns true when openClose implied or explicit.
 */
export function supportsPersistentSync(sync: WireServerCapabilities['textDocumentSync']): boolean {
  if (sync === undefined) return false
  if (typeof sync === 'number') return isOpenCloseKind(sync)
  return sync.openClose === true
}

function isOpenCloseKind(kind: WireTextDocumentSyncKind): boolean {
  return kind === 1 || kind === 2
}

/** Whether a value is a valid wire coordinate. */
function isProtocolCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return isProtocolCoordinate(p.line) && isProtocolCoordinate(p.character)
}

function isRange(value: unknown): value is WireRange {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return isPosition(r.start) && isPosition(r.end)
}

function toRange(range: WireRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/**
 * Normalize a wire diagnostic array into seam diagnostics, dropping malformed entries fail-loud? No — filter invalid.
 * @param diagnostics - raw wire diagnostics.
 * @param defaultUri - uri to attach when normalizing (publishDiagnostics gives it separately; pull gives per-item uri).
 * @returns normalized diagnostics.
 */
export function normalizeDiagnostics(diagnostics: readonly WireDiagnostic[], defaultUri?: string): LspDiagnostic[] {
  const out: LspDiagnostic[] = []
  for (const d of diagnostics) {
    if (typeof d !== 'object') continue
    const rec = d as unknown as Record<string, unknown>
    const range = rec.range
    const message = rec.message
    if (!isRange(range) || typeof message !== 'string') continue
    const severity = rec.severity
    const code = rec.code
    const source = rec.source
    const normalized: LspDiagnostic = {
      uri: (typeof (rec as { uri?: unknown }).uri === 'string' ? (rec as { uri: string }).uri : defaultUri) ?? '',
      range: toRange(range),
      message,
      ...(typeof severity === 'number' && [1, 2, 3, 4].includes(severity) ? { severity: severity as 1 | 2 | 3 | 4 } : {}),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
      ...(typeof source === 'string' ? { source } : {}),
    }
    if (normalized.uri === '') continue
    out.push(normalized)
  }
  return out
}

/**
 * Deduplicate diagnostics by stable JSON key of {code, severity, message, source, range}.
 * Matches opencode client.ts:91-105 dedupeDiagnostics.
 * @param items - diagnostics to dedupe (preserves first occurrence order).
 * @returns deduped array.
 */
export function dedupeDiagnostics(items: readonly LspDiagnostic[]): LspDiagnostic[] {
  const seen = new Set<string>()
  const out: LspDiagnostic[] = []
  for (const item of items) {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Merge push + pull maps for a file, dedupe, and cap.
 * @param push - push diagnostics for this file (publishDiagnostics).
 * @param pull - pull diagnostics for this file (textDocument/diagnostic + workspace/diagnostic).
 * @returns merged, deduped, capped diagnostics.
 */
export function mergeDiagnosticsForFile(
  push: readonly LspDiagnostic[] | undefined,
  pull: readonly LspDiagnostic[] | undefined,
): readonly LspDiagnostic[] {
  const merged = [...(push ?? []), ...(pull ?? [])]
  const deduped = dedupeDiagnostics(merged)
  return deduped.length > MAX_PER_FILE ? deduped.slice(0, MAX_PER_FILE) : deduped
}

/**
 * Cap a byFile map to MAX_FILES_PER_SNAPSHOT entries (deterministic: sorted keys, keep first N).
 * @param byFile - full map.
 * @returns capped map.
 */
export function capSnapshotFiles(byFile: ReadonlyMap<string, readonly LspDiagnostic[]>): ReadonlyMap<string, readonly LspDiagnostic[]> {
  if (byFile.size <= MAX_FILES_PER_SNAPSHOT) return byFile
  const sorted = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))
  return new Map(sorted.slice(0, MAX_FILES_PER_SNAPSHOT))
}
