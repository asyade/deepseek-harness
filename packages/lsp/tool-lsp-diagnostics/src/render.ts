/**
 * Pure formatting for the `lsp-diagnostics` tool: severity-aware diagnostic
 * pretty-printing, per-file and cross-file capping, bounded result rendering,
 * and UI presentation. Mirrors opencode `%70ackages/opencode/src/lsp/diagnostic.ts:1-27`
 * (`MAX_PER_FILE=20`, severity 1 filter, `<diagnostics file="...">` wrapper) and
 * `write.ts:18` (`MAX_PROJECT_DIAGNOSTICS_FILES=5`), plus the harness
 * `maxResultChars` bounding from `tool-lsp`.
 * No I/O — a UI may call the presenter on live streaming and on replay.
 * @module @deepseek-ai/dsh-tool-lsp-diagnostics/render
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { LspDiagnostic } from '@deepseek-ai/dsh-lsp-diagnostics'

/** Default cap on files in the rendered result (opencode `write.ts:18`). */
export const DEFAULT_MAX_FILES = 5

/** Default cap on diagnostics per file (opencode `diagnostic.ts:1`). */
export const DEFAULT_MAX_PER_FILE = 20

/** Default cap on the complete rendered tool result, including truncation metadata (like `tool-lsp`). */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/** The raw, schema-typed argument shape for presentation. */
export interface LspDiagnosticsToolArgs {
  readonly file_path?: string
}

/**
 * Pretty-print one diagnostic as `SEVERITY [line:col] message` (like opencode `diagnostic.ts:5-14`).
 * `severity` defaults to 1 (Error) when absent; line/col are one-based for the model.
 * @param diagnostic - normalized diagnostic (zero-based range).
 * @returns formatted line.
 */
export function prettyDiagnostic(diagnostic: LspDiagnostic): string {
  const severityMap: Record<number, string> = {
    1: 'ERROR',
    2: 'WARN',
    3: 'INFO',
    4: 'HINT',
  }
  const severity = severityMap[diagnostic.severity] ?? 'ERROR'
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1
  return `${severity} [${line}:${col}] ${diagnostic.message}`
}

/**
 * Render one file's diagnostics as `<diagnostics file="...">` block (like opencode `diagnostic.ts:20-27`).
 * Filters to severity 1 (Error) by default — `diagnostic.severity ?? 1` === 1 — caps to `maxPerFile`,
 * and appends `... and N more`.
 * @param file - file path or URI for the wrapper attribute.
 * @param diagnostics - diagnostics for that file (already severity-filtered or raw).
 * @param maxPerFile - cap before `... and N more` suffix.
 * @returns the block, or `""` when there are no severity-1 diagnostics.
 */
export function report(file: string, diagnostics: readonly LspDiagnostic[], maxPerFile: number): string {
  const errors = diagnostics.filter(item => item.severity === 1)
  if (errors.length === 0) return ''
  const limited = errors.slice(0, maxPerFile)
  const more = errors.length - maxPerFile
  const suffix = more > 0 ? `\n... and ${more} more` : ''
  return `<diagnostics file="${file}">\n${limited.map(prettyDiagnostic).join('\n')}${suffix}\n</diagnostics>`
}

/**
 * Render a grouped diagnostics result (multiple files) with cross-file and per-file capping,
 * mirroring opencode's per-file `report` plus harness `5 files` limit. Applies `maxResultChars` last.
 * @param grouped - diagnostics grouped by file (already or not yet capped).
 * @param maxFiles - cross-file cap before omission marker.
 * @param maxPerFile - per-file cap passed to `report`.
 * @param maxResultChars - complete rendered-text cap, including truncation metadata.
 * @returns the rendered text; distinct no-result line when there are none.
 */
export function formatDiagnostics(
  grouped: readonly { file: string; diagnostics: readonly LspDiagnostic[] }[],
  maxFiles: number,
  maxPerFile: number,
  maxResultChars: number,
): string {
  if (grouped.length === 0) return boundResult('No diagnostics.', maxResultChars, 'diagnostics')
  const shown = grouped.slice(0, maxFiles)
  const omittedFiles = grouped.length - shown.length
  const parts: string[] = []
  for (const entry of shown) {
    const block = report(entry.file, entry.diagnostics, maxPerFile)
    if (block !== '') parts.push(block)
  }
  if (parts.length === 0) return boundResult('No diagnostics.', maxResultChars, 'diagnostics')
  let text = parts.join('\n')
  if (omittedFiles > 0) {
    text += `\n… ${omittedFiles} more file${omittedFiles === 1 ? '' : 's'} omitted (limit ${maxFiles}).`
  }
  return boundResult(text, maxResultChars, 'diagnostics')
}

/** Bound a complete rendered result, including the truncation notice itself. */
function boundResult(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const notice = `\n… ${label} truncated (limit ${maxChars} characters).`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

/**
 * UI presentation for a pending `lsp-diagnostics` call. Uses a generic search card;
 * the title carries the file filter when present.
 * @param args - raw tool arguments.
 * @returns generic call view.
 */
export function presentDiagnosticsCall(args: LspDiagnosticsToolArgs): GenericCallView {
  const target = args.file_path !== undefined && args.file_path.trim().length > 0 ? args.file_path : 'workspace'
  return {
    card: 'generic',
    kind: 'search',
    title: `LSP diagnostics ${target}`,
    locations: args.file_path !== undefined && args.file_path.trim().length > 0 ? [{ path: args.file_path, line: 1 }] : [],
  }
}
