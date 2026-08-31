/**
 * Service Definition for the diagnostics capability seam (`ctx.lspDiagnostics`): a diagnostics
 * provider registry and workspace-scoped snapshot query plus push observation.
 *
 * A provider reserves a branded id atomically (`registerProvider` validates before mutating, so an
 * invalid or conflicting registration publishes nothing). For v1 the seam holds a single global
 * provider (one per harness), like `ctx.lsp` but without an extension map. `diagnostics` is
 * workspace-scoped: the seam canonicalizes `workspaceRoot` (a lightweight copy of the
 * `canonicalizeWorkspace` helper at `packages/lsp/lsp-stdio/src/host.ts:32-59` — trimming and
 * trailing-separator normalization, without `ctx.fs` involvement) and delegates to the registered
 * provider. `onDiagnostics` subscribes to debounced push snapshots; the service forwards provider
 * pushes to all service listeners.
 *
 * The seam exposes no JSON-RPC escape hatch and no document/process controls — only the typed
 * snapshot and the push subscription. Dedup and caps mirror opencode `client.ts:91-105` and
 * `diagnostic.ts:1` / `write.ts:18` (`MAX_PER_FILE=20`, cross-file 5, `maxResultChars` 16_000),
 * but the seam itself does not enforce them; providers do.
 * @module @deepseek-ai/dsh-lsp-diagnostics
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { LspDiagnosticsProviderId } from './brand.ts'
import type {
  LspDiagnosticsProvider,
  LspDiagnosticsRequest,
  LspDiagnosticsSnapshot,
  LspDiagnosticsService,
} from './types.ts'

export { LspDiagnosticsProviderId } from './brand.ts'
export type {
  LspDiagnostic,
  LspDiagnosticsProvider,
  LspDiagnosticsRequest,
  LspDiagnosticsService,
  LspDiagnosticsSnapshot,
  LspPosition,
  LspRange,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lspDiagnostics: LspDiagnosticsService
  }
}

/**
 * Structured diagnostics failure. Extends {@link HarnessError} with a stable `code`
 * (`LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, `LSP_UNAVAILABLE`) that callers route on instead of
 * parsing `message`. Mirrors the `LspError` taxonomy for 100% coverage parity.
 */
export class LspError extends HarnessError {}

/** Alias for callers that prefer the diagnostics-suffixed name. */
export const LspDiagnosticsError = LspError
/** Alias for callers that prefer the diagnostics-suffixed name. */
export type LspDiagnosticsError = LspError

/**
 * Lightweight workspace canonicalization for the diagnostics seam. This is a synchronous,
 * `ctx.fs`-free analogue of `canonicalizeWorkspace` at `packages/lsp/lsp-stdio/src/host.ts:32-59`:
 * it trims the caller-supplied `workspaceRoot`, rejects empty input, and normalizes trailing
 * separators so `" /ws/ "` and `"/ws"` select the same workspace. The provider remains
 * responsible for any `FsTarget`-level canonicalization that needs `ctx.fs`/`ctx.subprocess`.
 * @param workspaceRoot - caller-supplied workspace root.
 * @returns canonical workspace root.
 * @throws LspError `LSP_INVALID_PROVIDER` when `workspaceRoot` is empty after trimming.
 */
export function canonicalizeWorkspaceRoot(workspaceRoot: string): string {
  const trimmed = workspaceRoot.trim()
  if (trimmed === '') {
    throw new LspError('workspaceRoot must be a non-empty string', 'LSP_INVALID_PROVIDER')
  }
  let canonical = trimmed
  while (canonical.length > 1 && (canonical.endsWith('/') || canonical.endsWith('\\'))) {
    canonical = canonical.slice(0, -1)
  }
  return canonical
}

/**
 * `ctx.lspDiagnostics`. Holds the id reservation and the single global provider; both are
 * populated and cleared together per provider so a route always has a live provider. Push
 * subscriptions are forwarded from provider to service listeners.
 */
export class LspDiagnostics extends Service implements LspDiagnosticsService {
  private readonly providerIds = new Set<LspDiagnosticsProviderId>()
  private provider: LspDiagnosticsProvider | undefined
  private readonly listeners = new Set<(snapshot: LspDiagnosticsSnapshot) => void>()

  constructor(ctx: Context) {
    super(ctx, 'lspDiagnostics')
  }

  registerProvider(provider: LspDiagnosticsProvider): () => void {
    // Validate and conflict-check everything BEFORE any mutation: an invalid or conflicting
    // registration must publish nothing (fail-loud, all-or-nothing).
    const id = provider.id
    if (id.trim() === '') {
      throw new LspError('a diagnostics provider id must be a non-empty string', 'LSP_INVALID_PROVIDER')
    }
    if (this.providerIds.has(id)) {
      throw new LspError(`a diagnostics provider with id "${id}" is already registered`, 'LSP_CONFLICT')
    }
    // v1: single global provider (one per harness). A second provider with a different id still
    // conflicts because selection is not per-workspace yet (the seam would need a Map
    // workspaceRoot->Route). For now keep the seam simple and conflict on any existing provider.
    if (this.provider !== undefined) {
      throw new LspError('a diagnostics provider is already registered', 'LSP_CONFLICT')
    }

    // All checks passed: reserve id and provider in one lifecycle controller so disposal releases
    // them together and tears down the push forwarding.
    const dispose = this.ctx.effect(function* (this: LspDiagnostics) {
      this.providerIds.add(id)
      this.provider = provider
      const unsubscribe = provider.onDiagnostics((snapshot) => {
        for (const listener of this.listeners) {
          try {
            listener(snapshot)
          } catch {
            // Isolate listener throws: observation must not break the carrier.
          }
        }
      })
      yield () => {
        try {
          unsubscribe()
        } catch {}
        this.provider = undefined
        this.providerIds.delete(id)
      }
    }.bind(this), 'lspDiagnostics.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is synchronous fire-and-forget.
    return () => void dispose()
  }

  async diagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsSnapshot> {
    const canonical = canonicalizeWorkspaceRoot(request.workspaceRoot)
    if (this.provider === undefined) {
      throw new LspError('no diagnostics provider is registered', 'LSP_UNAVAILABLE')
    }
    const canonicalRequest: LspDiagnosticsRequest = {
      workspaceRoot: canonical,
      ...(request.filePath !== undefined ? { filePath: request.filePath } : {}),
    }
    return this.provider.diagnostics(canonicalRequest, signal)
  }

  onDiagnostics(listener: (snapshot: LspDiagnosticsSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export default LspDiagnostics
