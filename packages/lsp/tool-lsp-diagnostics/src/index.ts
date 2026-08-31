/**
 * Model-facing `lsp-diagnostics` tool over `ctx.lspDiagnostics`. One read-only tool that pulls
 * the current diagnostics snapshot for the session workspace (optionally filtered to a single file),
 * caps and renders results, and attaches a configurable timeout budget for
 * `dsh-tool-call-timeout-policy` to enforce. It runtime-injects only `tools`,
 * `lspDiagnostics`, and `systemPrompt` and imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-lsp-diagnostics
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LspError } from '@deepseek-ai/dsh-lsp-diagnostics'
import type { LspDiagnostic, LspDiagnosticsSnapshot } from '@deepseek-ai/dsh-lsp-diagnostics'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PER_FILE,
  DEFAULT_MAX_RESULT_CHARS,
  formatDiagnostics,
  presentDiagnosticsCall,
} from './render.ts'
import { sessionCwd } from './session-cwd.ts'

export {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PER_FILE,
  DEFAULT_MAX_RESULT_CHARS,
  formatDiagnostics,
  presentDiagnosticsCall,
  report,
  prettyDiagnostic,
} from './render.ts'
export { sessionCwd } from './session-cwd.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-lsp-diagnostics'

/** Services required by this plugin. */
export const inject = ['tools', 'lspDiagnostics', 'systemPrompt']

/** Default tool-call timeout budget (ms), covering the snapshot pull. */
export const DEFAULT_LSP_DIAGNOSTICS_TOOL_TIMEOUT_MS = 10_000

/** The stable system-prompt guidance positioning diagnostics as a pull snapshot. */
export const LSP_DIAGNOSTICS_PROMPT_TEXT =
  'Use lsp-diagnostics to pull the current diagnostics snapshot after writes. It returns the debounced snapshot (errors only by default, 5 files×20 per file, capped) — not a live push stream. Filter with file_path for one file; omit for workspace.'

/** Plugin configuration: timeout budget and optional caps. */
export interface Config {
  /** Tool-call timeout budget in ms (default 10_000). */
  timeoutMs?: number
  /** Largest number of files in the result before omission (default 5). */
  maxFiles?: number
  /** Largest diagnostics per file before omission (default 20). */
  maxPerFile?: number
  /** Largest complete rendered result in characters (default 16_000). */
  maxResultChars?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_LSP_DIAGNOSTICS_TOOL_TIMEOUT_MS),
  maxFiles: z.number().default(DEFAULT_MAX_FILES),
  maxPerFile: z.number().default(DEFAULT_MAX_PER_FILE),
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
})

type ResolvedConfig = Required<Config>

const LSP_POSITION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true },
    character: { type: 'integer', required: true },
  },
} as const

const LSP_RANGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
    end: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
  },
} as const

const LSP_DIAGNOSTIC_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    uri: { type: 'string', required: true },
    range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
    severity: { type: 'number' },
    code: {
      oneOf: [{ type: 'string' }, { type: 'number' }],
    },
    source: { type: 'string' },
    message: { type: 'string', required: true },
  },
} as const

/**
 * Register the `lsp-diagnostics` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `lspDiagnostics`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertTimer('timeoutMs', resolved.timeoutMs)
  assertPositiveInteger('maxFiles', resolved.maxFiles)
  assertPositiveInteger('maxPerFile', resolved.maxPerFile)
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)

  ctx.systemPrompt.section({
    name: 'tool:lsp-diagnostics',
    order: ctx.systemPrompt.getSectionOrder('TOOL_LSP'),
    text: LSP_DIAGNOSTICS_PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'lsp-diagnostics',
    description:
      'Pull current diagnostics snapshot for the workspace or a single file. Returns capped diagnostics (errors only by default, 5 files×20 per file). Use after writes to check for compile errors without rediscovering them.',
    parameters: {
      file_path: {
        type: 'string',
        description: 'File to filter diagnostics to, relative to workspace or absolute. When omitted, returns workspace snapshot (capped to 5 files).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'diagnostics' },
          diagnostics: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                diagnostics: {
                  type: 'array',
                  required: true,
                  items: LSP_DIAGNOSTIC_OUTPUT_SCHEMA,
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const diagnostics = (value as { diagnostics: Array<{ file: string; diagnostics: LspDiagnostic[] }> }).diagnostics
        return [
          {
            type: 'text',
            text: formatDiagnostics(
              diagnostics,
              resolved.maxFiles,
              resolved.maxPerFile,
              resolved.maxResultChars,
            ),
          },
        ]
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const rawFilePath = args.file_path
      const filePath =
        typeof rawFilePath === 'string' && rawFilePath.trim().length > 0 ? rawFilePath : undefined
      if (rawFilePath !== undefined && filePath === undefined) {
        throw new Error('file_path must be a non-empty string when provided')
      }
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) {
        throw new LspError('the lsp-diagnostics tool requires a session workspace cwd', 'LSP_WORKSPACE_REQUIRED')
      }
      const snapshot: LspDiagnosticsSnapshot = await ctx.lspDiagnostics.diagnostics(
        {
          workspaceRoot,
          ...(filePath !== undefined ? { filePath } : {}),
        },
        exec.signal,
      )

      // Normalize snapshot.byFile (ReadonlyMap or plain Record) to entries, then cap.
      const entries: Array<[string, readonly LspDiagnostic[]]> = snapshot.byFile instanceof Map
        ? [...(snapshot.byFile as ReadonlyMap<string, readonly LspDiagnostic[]>).entries()]
        : Object.entries(snapshot.byFile as unknown as Record<string, readonly LspDiagnostic[]>)

      // If filePath was requested, narrow to that file with exact absolute-path match (no suffix over-match).
      let filtered = entries
      if (filePath !== undefined) {
        const toAbsolute = (p: string): string => {
          const normalized = p.replaceAll('\\', '/')
          if (normalized.startsWith('file://')) {
            try {
              return decodeURIComponent(new URL(normalized).pathname).replaceAll('\\', '/')
            } catch {
              return normalized
            }
          }
          if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return normalized
          const root = workspaceRoot.replaceAll('\\', '/').replace(/\/$/, '')
          return `${root}/${normalized.replace(/^\.\//, '')}`
        }
        const resolvedRequested = toAbsolute(filePath.replaceAll('\\', '/'))
        filtered = entries.filter(([file]) => toAbsolute(file) === resolvedRequested)
        if (filtered.length === 0 && entries.length > 0) {
          const direct = snapshot.byFile instanceof Map
            ? (snapshot.byFile as ReadonlyMap<string, readonly LspDiagnostic[]>).get(filePath)
            : (snapshot.byFile as unknown as Record<string, readonly LspDiagnostic[]>)[filePath]
          if (direct !== undefined) {
            filtered = [[filePath, direct]]
          }
        }
      }

      // Severity 1 default: keep only errors (severity ===1 or missing defaults to 1 per opencode)
      let grouped: Array<{ file: string; diagnostics: LspDiagnostic[] }> = filtered
        .map(([file, diagnostics]) => ({
          file,
          diagnostics: diagnostics.filter(d => d.severity === 1),
        }))
        .filter(entry => entry.diagnostics.length > 0)

      // Per-file cap
      grouped = grouped.map(entry => ({
        file: entry.file,
        diagnostics: entry.diagnostics.slice(0, resolved.maxPerFile),
      }))

      // Cross-file cap: 5 files
      const capped = grouped.slice(0, resolved.maxFiles)

      return {
        kind: 'diagnostics' as const,
        diagnostics: capped.map(entry => ({
          file: entry.file,
          diagnostics: entry.diagnostics.map(d => ({
            uri: d.uri,
            range: {
              start: { line: d.range.start.line, character: d.range.start.character },
              end: { line: d.range.end.line, character: d.range.end.character },
            },
            severity: d.severity,
            ...(d.code !== undefined ? { code: d.code } : {}),
            ...(d.source !== undefined ? { source: d.source } : {}),
            message: d.message,
          })),
        })),
      }
    },
    presentCall: presentDiagnosticsCall,
  }))
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-lsp-diagnostics: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-lsp-diagnostics: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
