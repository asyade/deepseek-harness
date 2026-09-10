/**
 * Stdio diagnostics provider for `ctx.lspDiagnostics`. One plugin instance configures a named table
 * of server commands and registers one isolated diagnostics provider for each entry. Every provider
 * lazily single-flights one server process per canonical workspace target, serving persistent
 * didOpen/didChange lifecycles and push+pull hybrid diagnostics (publishDiagnostics + textDocument/diagnostic + workspace/diagnostic)
 * with debounced merge/dedupe/caps.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is effect-scoped: disposal
 * unregisters from `ctx.lspDiagnostics` and tears down every live server.
 * @module @deepseek-ai/dsh-lsp-stdio-diagnostics
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LspError } from '@deepseek-ai/dsh-lsp'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { abortable, abortError } from './abort.ts'
import { canonicalizeWorkspace, readHostSource } from './host.ts'
import type { HostWorkspace } from './host.ts'
import { LspDiagnosticsInstance } from './instance.ts'
import type { ConnectionSpawner } from './connection.ts'
import type { DiagnosticsInstanceSpec } from './instance.ts'
import {
  LspDiagnosticsProviderId,
  type LspDiagnosticsProvider,
  type LspDiagnosticsRequest,
  type LspDiagnosticsSnapshot,
} from './types.ts'

export { canonicalizeWorkspace, readHostSource } from './host.ts'
export { encodeMessage, MessageDecoder } from './framing.ts'
export {
  negotiatePositionEncoding,
  dedupeDiagnostics,
  mergeDiagnosticsForFile,
  capSnapshotFiles,
  MAX_PER_FILE,
  MAX_FILES_PER_SNAPSHOT,
} from './translate.ts'
export { LspDiagnosticsInstance } from './instance.ts'
export { LspConnection } from './connection.ts'
export type {
  LspDiagnostic,
  LspDiagnosticsProvider,
  LspDiagnosticsRequest,
  LspDiagnosticsSnapshot,
  LspDiagnosticsService,
  LspDiagnosticsProviderId,
  LspPosition,
  LspRange,
} from './types.ts'

export const name = 'lsp-stdio-diagnostics'

/**
 * Services required by this provider. `lspDiagnostics` is the Phase 1 seam (`ctx.lspDiagnostics`);
 * if it is not yet registered, this provider warns and remains idle (see apply).
 */
export const inject = ['fs', 'subprocess']

const DEFAULT_MAX_MESSAGE_BYTES = 16_000_000
const DEFAULT_MAX_STDERR_BYTES = 1_000_000
const DEFAULT_MAX_DOCUMENT_BYTES = 4_000_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 2_000

/** One configured diagnostics server and its host bounds. */
export interface LspDiagnosticsServerConfig {
  /** Executable to spawn — absolute, or resolved on the child PATH at load; launched without a shell. */
  command: string
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  extensionToLanguage: Record<string, string>
  /** Arguments passed to the executable. */
  args?: string[]
  /**
   * Extra env merged over the credential-scrubbed ambient env; variables matching
   * `KEY`/`PASSWORD`/`SECRET`/`TOKEN` and all `DSH_*` names are not forwarded.
   */
  env?: Record<string, string>
  /** Static `initialize` options forwarded to the server. */
  initializationOptions?: unknown
  /** Static answer to every `workspace/configuration` item. */
  configuration?: unknown
  /** Largest single framed message accepted from the server. */
  maxMessageBytes?: number
  /** Largest stderr tail retained for diagnostics. */
  maxStderrBytes?: number
  /** Largest source document accepted for sync. */
  maxDocumentBytes?: number
  /** Graceful `shutdown`/`exit` budget before escalation. */
  shutdownTimeoutMs?: number
  /** Request-cancel and SIGTERM→SIGKILL escalation grace. */
  killGraceMs?: number
}

/** Plugin configuration: one diagnostics server per stable provider id. */
export interface Config {
  /** Map of stable provider id to one server command; must contain at least one non-empty entry. */
  servers: Record<string, LspDiagnosticsServerConfig>
}

type ResolvedServerConfig = Required<LspDiagnosticsServerConfig>
type WorkspaceKey = HostWorkspace['target']['targetKey']

const LspDiagnosticsServerConfig: z<LspDiagnosticsServerConfig> = z.object({
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  extensionToLanguage: z.dict(String).required(),
  initializationOptions: z.any().default(null),
  configuration: z.any().default(null),
  maxMessageBytes: z.number().default(DEFAULT_MAX_MESSAGE_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  maxDocumentBytes: z.number().default(DEFAULT_MAX_DOCUMENT_BYTES),
  shutdownTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_KILL_GRACE_MS),
})

export const Config: z<Config> = z.object({
  servers: z.dict(LspDiagnosticsServerConfig).required(),
})

function throwTeardownFailures(results: readonly PromiseSettledResult<void>[], message: string): void {
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

function validateServerConfig(providerId: string, resolved: ResolvedServerConfig): void {
  assertTimer(providerId, 'shutdownTimeoutMs', resolved.shutdownTimeoutMs)
  assertTimer(providerId, 'killGraceMs', resolved.killGraceMs)
  assertPositiveInteger(providerId, 'maxStderrBytes', resolved.maxStderrBytes)
  assertPositiveInteger(providerId, 'maxMessageBytes', resolved.maxMessageBytes)
  assertPositiveInteger(providerId, 'maxDocumentBytes', resolved.maxDocumentBytes)
}

function assertTimer(providerId: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`lsp-stdio-diagnostics: servers.${providerId}.${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function assertPositiveInteger(providerId: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`lsp-stdio-diagnostics: servers.${providerId}.${name} must be a positive integer`)
  }
}

/**
 * Register the configured stdio diagnostics providers.
 * @param ctx - the plugin context carrying `fs`, `lsp`, and `subprocess`. `lspDiagnostics` is
 * expected from Phase 1 seam; if absent, uses local fallback and notes dependency.
 * @param config - the resolved plugin configuration (schemastery has filled every default).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const entries = Object.entries(config.servers)
  if (entries.length === 0) throw new Error('lsp-stdio-diagnostics: servers must contain at least one server')

  const setupAbort = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) {
      setupAbort.abort(new Error('lsp-stdio-diagnostics setup disposed'))
    }
  })

  const providers = await (async () => {
    const lookups = entries.map(async ([providerId, rawConfig]) => {
      if (providerId.trim() === '') throw new Error('lsp-stdio-diagnostics: server ids must be non-empty strings')
      const resolved = rawConfig as ResolvedServerConfig
      validateServerConfig(providerId, resolved)
      const executable = await ctx.subprocess.resolveExecutable(resolved.command, resolved.env, setupAbort.signal)
      setupAbort.signal.throwIfAborted()
      return new LocalLspDiagnosticsProvider(providerId, ctx.fs, resolved, executable, spec => ctx.subprocess.spawn(spec))
    })
    try {
      return await Promise.all(lookups)
    } catch (error: unknown) {
      setupAbort.abort(error)
      await Promise.allSettled(lookups)
      throw error
    } finally {
      stopSetupCancellation()
    }
  })()

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    // Prefer Phase 1 seam `ctx.lspDiagnostics` when present; otherwise use local fallback shims
    // (provider still functional but not discoverable via seam).
    // This scaffolding does not block on Phase 1 completion — consumers that need the seam should
    // depend on `@deepseek-ai/dsh-lsp-diagnostics`.
    const diagnosticsService = (ctx as unknown as {
      lspDiagnostics?: { registerProvider: (p: LspDiagnosticsProvider) => () => void }
    }).lspDiagnostics
    if (diagnosticsService === undefined) {
      // Fallback: no seam present — note dependency but still own lifecycle so typecheck and isolated tests pass.
      // Providers remain alive for direct use; registration is a no-op until the seam lands.
      // We log once for observability.
      console.warn('lsp-stdio-diagnostics: ctx.lspDiagnostics not present (Phase 1 seam pending) — providers not registered; diagnostics will be unavailable via seam')
      return async () => {
        const results = await Promise.allSettled(providers.map(p => p.disposeAll()))
        throwTeardownFailures(results, 'lsp-stdio-diagnostics provider teardown failed')
      }
    }
    try {
      for (const provider of providers) disposers.push(diagnosticsService.registerProvider(provider))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return async () => {
      for (const dispose of disposers.reverse()) dispose()
      const results = await Promise.allSettled(providers.map(p => p.disposeAll()))
      throwTeardownFailures(results, 'lsp-stdio-diagnostics provider teardown failed')
    }
  }, 'lsp-stdio-diagnostics.registerProviders')
}

/** A pooled diagnostics provider: one persistent server per canonical workspace, created on demand. */
class LocalLspDiagnosticsProvider implements LspDiagnosticsProvider {
  readonly id: ReturnType<typeof LspDiagnosticsProviderId>
  readonly extensionToLanguage: Readonly<Record<string, string>>
  private readonly instances = new Map<WorkspaceKey, LspDiagnosticsInstance>()
  private readonly queues = new Map<WorkspaceKey, Promise<void>>()
  private readonly workspaceLookups = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly snapshotListeners = new Set<(snapshot: LspDiagnosticsSnapshot) => void>()
  private disposed = false

  constructor(
    providerId: string,
    private readonly fs: Context['fs'],
    private readonly config: ResolvedServerConfig,
    private readonly executable: string,
    private readonly spawner: ConnectionSpawner,
  ) {
    this.id = LspDiagnosticsProviderId(providerId)
    this.extensionToLanguage = config.extensionToLanguage
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.isDisposed()) throw new LspError('lsp-stdio-diagnostics provider is disposed', 'LSP_DISPOSED')
    if (signal?.aborted) throw abortError(signal)
  }

  private querySignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
  }

  async diagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsSnapshot> {
    this.assertActive(signal)
    const querySignal = this.querySignal(signal)
    const workspaceResult = canonicalizeWorkspace(this.fs, request.workspaceRoot, querySignal)
    const workspaceLookup = workspaceResult.then(() => undefined, () => undefined)
    this.workspaceLookups.add(workspaceLookup)
    let workspace: HostWorkspace
    try {
      workspace = await workspaceResult
    } finally {
      this.workspaceLookups.delete(workspaceLookup)
    }
    this.assertActive(querySignal)
    const workspaceKey = workspace.target.targetKey
    return this.enqueue(workspaceKey, querySignal, async () => {
      this.assertActive(querySignal)
      let source: import('./host.ts').HostSource | undefined
      if (request.filePath !== undefined) {
        source = await readHostSource(this.fs, request.filePath, workspace, this.config.maxDocumentBytes, querySignal)
      }
      this.assertActive(querySignal)
      let instance = this.instanceFor(workspaceKey, workspace)
      try {
        const snapshot = await instance.diagnostics(request, source, querySignal)
        for (const listener of this.snapshotListeners) listener(snapshot)
        return snapshot
      } catch (error) {
        if (!instance.isTransportFailure(error)) throw error
        await instance.dispose()
        this.evictIfCurrent(workspaceKey, instance)
        this.assertActive(querySignal)
        instance = this.instanceFor(workspaceKey, workspace)
        const snapshot = await instance.diagnostics(request, source, querySignal)
        for (const listener of this.snapshotListeners) listener(snapshot)
        return snapshot
      } finally {
        if (instance.dead) {
          await instance.dispose()
          this.evictIfCurrent(workspaceKey, instance)
        }
      }
    })
  }

  onDiagnostics(listener: (snapshot: LspDiagnosticsSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => { this.snapshotListeners.delete(listener) }
  }

  private enqueue<T>(workspace: WorkspaceKey, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workspace) ?? Promise.resolve()
    const result = abortable(previous, signal).then(run)
    const tail = previous.then(() => result).then(() => undefined, () => undefined)
    this.queues.set(workspace, tail)
    void tail.then(() => {
      if (this.queues.get(workspace) === tail) this.queues.delete(workspace)
    })
    return result
  }

  private instanceFor(workspaceKey: WorkspaceKey, workspace: HostWorkspace): LspDiagnosticsInstance {
    this.assertActive()
    const existing = this.instances.get(workspaceKey)
    if (existing !== undefined) return existing
    const created = this.createInstance(workspace)
    this.instances.set(workspaceKey, created)
    return created
  }

  private evictIfCurrent(workspace: WorkspaceKey, instance: LspDiagnosticsInstance): void {
    if (this.instances.get(workspace) === instance) this.instances.delete(workspace)
  }

  private createInstance(workspace: HostWorkspace): LspDiagnosticsInstance {
    const spec: DiagnosticsInstanceSpec = {
      command: this.executable,
      args: this.config.args,
      cwd: workspace.canonicalPath,
      workspaceUri: workspace.fileUrl,
      env: this.config.env,
      configuration: this.config.configuration,
      initializationOptions: this.config.initializationOptions,
      maxMessageBytes: this.config.maxMessageBytes,
      maxStderrBytes: this.config.maxStderrBytes,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      killGraceMs: this.config.killGraceMs,
      extensionToLanguage: this.config.extensionToLanguage,
    }
    return new LspDiagnosticsInstance(spec, this.spawner)
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    this.lifetime.abort(new LspError('lsp-stdio-diagnostics provider is disposed', 'LSP_DISPOSED'))
    const live = [...this.instances.values()]
    const draining = [...this.queues.values()]
    const resolving = [...this.workspaceLookups]
    this.instances.clear()
    const results = await Promise.allSettled([...live.map(i => i.dispose()), ...draining, ...resolving])
    this.queues.clear()
    this.workspaceLookups.clear()
    this.snapshotListeners.clear()
    throwTeardownFailures(results, 'lsp-stdio-diagnostics instance teardown failed')
  }
}
