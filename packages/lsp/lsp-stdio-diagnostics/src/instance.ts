/**
 * One language-server instance for diagnostics: persistent document sync, push (publishDiagnostics)
 * + pull (textDocument/diagnostic + workspace/diagnostic) hybrid, debounced merge/dedupe/caps.
 * One instance owns one (provider id, canonical workspace) process.
 * @module @deepseek-ai/dsh-lsp-stdio-diagnostics/instance
 */

import { LspError } from '@deepseek-ai/dsh-lsp'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { abortable, abortError } from './abort.ts'
import { LspConnection } from './connection.ts'
import type { ConnectionSpawner, ConnectionSpec, ConnectionWriter } from './connection.ts'
import type { HostSource } from './host.ts'
import type {
  WireCapabilityRegistration,
  WireDiagnostic,
  WireDocumentDiagnosticReport,
  WireInitializeResult,
  WirePublishDiagnosticsParams,
  WireServerCapabilities,
  WireWorkspaceDiagnosticItem,
  WireWorkspaceDiagnosticReport,
} from './protocol.ts'
import {
  capSnapshotFiles,
  dedupeDiagnostics,
  mergeDiagnosticsForFile,
  negotiatePositionEncoding,
  normalizeDiagnostics,
} from './translate.ts'
import type { LspDiagnostic, LspDiagnosticsRequest, LspDiagnosticsSnapshot } from './types.ts'

/** Tuning constants mirroring opencode client.ts */
export const DIAGNOSTICS_DEBOUNCE_MS = 150
/** Timeout budget for one textDocument/diagnostic or workspace/diagnostic pull request. */
export const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000
/** Timeout budget for waiting on a fresh per-file push/pull snapshot after a write. */
export const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
/** Timeout budget for waiting on a full workspace snapshot (push or pull). */
export const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
/** Largest number of diagnostics surfaced per file, mirroring opencode diagnostic.ts. */
export const MAX_PER_FILE = 20

const FILE_CHANGE_CREATED = 1
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

/** Everything an instance needs beyond the connection spec. */
export interface DiagnosticsInstanceSpec extends ConnectionSpec {
  readonly workspaceUri: string
  readonly initializationOptions: unknown
  readonly shutdownTimeoutMs: number
  readonly extensionToLanguage: Readonly<Record<string, string>>
}

interface DocumentState {
  version: number
  text: string
  languageId: string
}

interface DiagnosticRequestResult {
  handled: boolean
  matched: boolean
  byFile: Map<string, LspDiagnostic[]>
}

/**
 * A single initialized diagnostics server. Persistent document model.
 */
export class LspDiagnosticsInstance {
  private readonly connection: LspConnection
  private capabilities: WireServerCapabilities | undefined
  private syncKind: number | undefined
  private readonly files = new Map<string, DocumentState>()
  private readonly pushDiagnostics = new Map<string, LspDiagnostic[]>()
  private readonly pullDiagnostics = new Map<string, LspDiagnostic[]>()
  private readonly published = new Map<string, { at: number; version?: number }>()
  private readonly diagnosticRegistrations = new Map<string, WireCapabilityRegistration>()
  private readonly registrationListeners = new Set<() => void>()
  private readonly diagnosticListeners = new Set<(event: { uri: string }) => void>()
  // Whether initialize advertised a static diagnosticProvider; influences identifier fan-out (see opencode client.ts:258).
  private hasStaticPullDiagnostics = false
  private disposed = false
  private teardownPromise: Promise<void> | undefined
  private processClosed = false
  private readonly ready: Promise<void>

  constructor(private readonly spec: DiagnosticsInstanceSpec, spawner: ConnectionSpawner, writer?: ConnectionWriter) {
    this.connection = new LspConnection(
      spec,
      spawner,
      (method: string, params: unknown) => this.answerServerRequest(method, params),
      (method: string, params: unknown) => { this.handleNotification(method, params) },
      writer,
    )
    this.ready = this.initialize()
    this.ready.catch(() => {})
    void this.connection.closed.then(() => { this.processClosed = true })
  }

  /** Whether this instance is no longer usable (process exited, disposed, or transport failed). */
  get dead(): boolean {
    return this.processClosed || this.disposed || this.connection.failed
  }

  /**
   * Whether the given error is this instance's transport failure.
   * @param error - the error to compare against the recorded close reason.
   * @returns whether this instance failed with exactly that error.
   */
  isTransportFailure(error: unknown): boolean {
    return this.connection.failedWith(error)
  }

  /**
   * Ensure the document is synchronized with the server (didOpen or didChange).
   * @param uri - file URI
   * @param languageId - LSP language id
   * @param text - current text
   * @param signal - optional cancellation
   * @returns the document version after synchronization.
   */
  async syncDocument(uri: string, languageId: string, text: string, signal?: AbortSignal): Promise<number> {
    await abortable(this.ready, signal)
    const existing = this.files.get(uri)
    if (existing === undefined) {
      // New document: watchedFiles CREATED + didOpen version 0
      await abortable(
        this.connection.notify('workspace/didChangeWatchedFiles', {
          changes: [{ uri, type: FILE_CHANGE_CREATED }],
        }),
        signal,
      )
      // Do not wipe push/pull on open; clear previous stale entries for this uri
      this.pushDiagnostics.delete(uri)
      this.pullDiagnostics.delete(uri)
      await abortable(
        this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId, version: 0, text },
        }),
        signal,
      )
      this.files.set(uri, { version: 0, text, languageId })
      return 0
    }

    if (existing.text === text && existing.languageId === languageId) {
      // No change; still emit watchedFiles CHANGED for consistency? Opencode does emit CHANGED on every open.
      // We skip to avoid churn when content identical.
      return existing.version
    }

    // Existing document changed
    await abortable(
      this.connection.notify('workspace/didChangeWatchedFiles', {
        changes: [{ uri, type: FILE_CHANGE_CHANGED }],
      }),
      signal,
    )
    const nextVersion = existing.version + 1
    const isIncremental = this.syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
    const contentChanges = isIncremental
      ? [{ range: { start: { line: 0, character: 0 }, end: endPosition(existing.text) }, text }]
      : [{ text }]
    await abortable(
      this.connection.notify('textDocument/didChange', {
        textDocument: { uri, version: nextVersion },
        contentChanges,
      }),
      signal,
    )
    this.files.set(uri, { version: nextVersion, text, languageId })
    return nextVersion
  }

  /**
   * Diagnostics query: ensures sync if source provided, then hybrid pull, merge, dedupe, cap.
   * @param request - workspaceRoot + optional filePath filter (for provider's snapshot key)
   * @param source - optional host source for file-specific query (ensures didOpen/didChange)
   * @param signal - optional cancellation
   * @returns merged snapshot
   */
  async diagnostics(
    request: LspDiagnosticsRequest,
    source: HostSource | undefined,
    signal?: AbortSignal,
  ): Promise<LspDiagnosticsSnapshot> {
    if (this.disposed) throw new LspError('LSP diagnostics instance was disposed', 'LSP_DISPOSED')
    if (signal?.aborted) throw abortError(signal)
    try {
      await abortable(this.ready, signal)
    } catch (error) {
      if (!this.dead) await this.startTeardown()
      throw error
    }
    const caps = this.capabilities
    if (caps === undefined) throw new Error('LSP diagnostics instance is not initialized')

    let version: number | undefined
    let uri: string | undefined
    let after: number | undefined
    if (source !== undefined) {
      const languageId = languageIdForUri(source.fileUrl, this.spec.extensionToLanguage)
      after = Date.now()
      version = await this.syncDocument(source.fileUrl, languageId, source.text, signal)
      uri = source.fileUrl
      // Wait for debounced push + pull hybrid, mirroring opencode touchFile waitForDiagnostics document mode (5s)
      await this.waitForDocumentDiagnostics({ path: uri, version, after, signal })
    } else {
      // Workspace-wide: full hybrid pull (10s budget) with no file version gate
      await this.waitForFullDiagnostics({ path: '', version: 0, after: Date.now(), signal })
      if (this.pullDiagnostics.size === 0 && this.pushDiagnostics.size === 0) {
        await this.requestFullDiagnostics('', signal)
      }
    }

    // Build snapshot by merging push + pull for each file
    const byFile = new Map<string, readonly LspDiagnostic[]>()
    const allUris = new Set<string>([...this.pushDiagnostics.keys(), ...this.pullDiagnostics.keys()])
    for (const fileUri of allUris) {
      const merged = mergeDiagnosticsForFile(this.pushDiagnostics.get(fileUri), this.pullDiagnostics.get(fileUri))
      if (merged.length === 0 && fileUri !== uri) continue
      if (uri === undefined || fileUri === uri || merged.length > 0) {
        byFile.set(fileUri, merged)
      }
    }
    if (uri !== undefined && !byFile.has(uri)) {
      byFile.set(uri, [])
    }

    const capped = capSnapshotFiles(byFile)
    return {
      workspaceRoot: request.workspaceRoot,
      byFile: capped,
      at: Date.now(),
    }
  }

  private documentPullState(): { documentIdentifiers: string[]; supported: boolean } {
    const documentRegistrations = [...this.diagnosticRegistrations.values()].filter(
      registration => registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap(registration => registration.registerOptions?.identifier ?? [])),
      ],
      supported: this.hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  private workspacePullState(): { workspaceIdentifiers: string[]; supported: boolean } {
    const workspaceRegistrations = [...this.diagnosticRegistrations.values()].filter(
      registration => registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap(registration => registration.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    }
  }

  private hasCurrentFileDiagnostics(fileUri: string, results: DiagnosticRequestResult[]): boolean {
    return results.some(result => (result.byFile.get(fileUri)?.length ?? 0) > 0)
  }

  private mergeResults(fileUri: string, results: DiagnosticRequestResult[]): { handled: boolean; matched: boolean } {
    const handled = results.some(result => result.handled)
    const matched = results.some(result => result.matched)
    if (!handled) return { handled: false, matched: false }
    const merged = new Map<string, LspDiagnostic[]>()
    for (const result of results) {
      for (const [target, items] of result.byFile.entries()) {
        const existing = merged.get(target) ?? []
        merged.set(target, existing.concat(items))
      }
    }
    if (matched && fileUri !== '' && !merged.has(fileUri)) merged.set(fileUri, [])
    for (const [target, items] of merged.entries()) {
      this.pullDiagnostics.set(target, dedupeDiagnostics(items))
    }
    return { handled, matched }
  }

  private async requestDiagnostics(
    fileUri: string,
    requests: Array<Promise<DiagnosticRequestResult>>,
    done: (results: DiagnosticRequestResult[]) => boolean,
  ): Promise<{ handled: boolean; matched: boolean }> {
    if (requests.length === 0) return { handled: false, matched: false }
    const results: DiagnosticRequestResult[] = []
    return new Promise<{ handled: boolean; matched: boolean }>((resolve) => {
      let pending = requests.length
      let resolved = false
      const finish = (merged: { handled: boolean; matched: boolean }, force = false): void => {
        if (resolved) return
        if (!force && !done(results)) return
        resolved = true
        resolve(merged)
      }
      for (const request of requests) {
        void request.then((result) => {
          results.push(result)
          pending -= 1
          const merged = this.mergeResults(fileUri, results)
          finish(merged)
          if (pending === 0) finish(merged, true)
        })
      }
    })
  }

  private async requestDocumentDiagnostics(fileUri: string, signal?: AbortSignal): Promise<{ handled: boolean; matched: boolean }> {
    const state = this.documentPullState()
    if (!state.supported) return { handled: false, matched: false }
    return this.requestDiagnostics(
      fileUri,
      [
        this.requestDiagnosticReport(fileUri, undefined, signal),
        ...state.documentIdentifiers.map(identifier => this.requestDiagnosticReport(fileUri, identifier, signal)),
      ],
      results => this.hasCurrentFileDiagnostics(fileUri, results),
    )
  }

  private async requestFullDiagnostics(fileUri: string, signal?: AbortSignal): Promise<{ handled: boolean; matched: boolean }> {
    const documentState = this.documentPullState()
    const workspaceState = this.workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return { handled: false, matched: false }
    const promises: Array<Promise<DiagnosticRequestResult>> = []
    if (documentState.supported) promises.push(this.requestDiagnosticReport(fileUri || '', undefined, signal))
    for (const id of documentState.documentIdentifiers) promises.push(this.requestDiagnosticReport(fileUri || '', id, signal))
    if (workspaceState.supported) promises.push(this.requestWorkspaceDiagnosticReport(fileUri || '', undefined, signal))
    for (const id of workspaceState.workspaceIdentifiers) promises.push(this.requestWorkspaceDiagnosticReport(fileUri || '', id, signal))
    const results = await Promise.all(promises)
    return this.mergeResults(fileUri, results)
  }

  private async requestDiagnosticReport(
    fileUri: string,
    identifier: string | undefined,
    signal?: AbortSignal,
  ): Promise<DiagnosticRequestResult> {
    if (fileUri === '') return { handled: false, matched: false, byFile: new Map() }
    const params: Record<string, unknown> = {
      textDocument: { uri: fileUri },
      ...(identifier ? { identifier } : {}),
      previousResultId: '',
    }
    let report: unknown
    try {
      report = await this.withTimeout(
        this.connection.request('textDocument/diagnostic', params),
        DIAGNOSTICS_REQUEST_TIMEOUT_MS,
        signal,
      )
    } catch {
      return { handled: false, matched: false, byFile: new Map() }
    }
    if (report === null || typeof report !== 'object') {
      return { handled: false, matched: false, byFile: new Map() }
    }
    const rec = report as WireDocumentDiagnosticReport & Record<string, unknown>
    const byFile = new Map<string, LspDiagnostic[]>()
    let handled = false
    let matched = false
    if (Array.isArray(rec.items)) {
      const items = normalizeDiagnostics(rec.items as readonly WireDiagnostic[], fileUri)
      byFile.set(fileUri, items)
      handled = true
      matched = true
    }
    if (typeof rec.relatedDocuments === 'object') {
      for (const [uri, related] of Object.entries(rec.relatedDocuments)) {
        if (!Array.isArray(related.items)) continue
        const items = normalizeDiagnostics(related.items as readonly WireDiagnostic[], uri)
        const existing = byFile.get(uri) ?? []
        byFile.set(uri, existing.concat(items))
        handled = true
        if (uri === fileUri) matched = true
      }
    }
    if (!handled) {
      if ('items' in rec) handled = true
    }
    return { handled, matched, byFile }
  }

  private async requestWorkspaceDiagnosticReport(
    fileUri: string,
    identifier: string | undefined,
    signal?: AbortSignal,
  ): Promise<DiagnosticRequestResult> {
    const params: Record<string, unknown> = {
      ...(identifier ? { identifier } : {}),
      previousResultIds: [],
    }
    let report: unknown
    try {
      report = await this.withTimeout(
        this.connection.request('workspace/diagnostic', params),
        DIAGNOSTICS_REQUEST_TIMEOUT_MS,
        signal,
      )
    } catch {
      return { handled: false, matched: false, byFile: new Map() }
    }
    if (report === null || typeof report !== 'object') {
      return { handled: false, matched: false, byFile: new Map() }
    }
    const rec = report as WireWorkspaceDiagnosticReport
    const byFile = new Map<string, LspDiagnostic[]>()
    let matched = false
    if (Array.isArray(rec.items)) {
      for (const item of rec.items as readonly WireWorkspaceDiagnosticItem[]) {
        if (typeof item.uri !== 'string' || !Array.isArray(item.items)) continue
        const items = normalizeDiagnostics(item.items as readonly WireDiagnostic[], item.uri)
        const existing = byFile.get(item.uri) ?? []
        byFile.set(item.uri, existing.concat(items))
        if (item.uri === fileUri) matched = true
      }
    }
    const handled = true
    return { handled, matched, byFile }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw abortError(signal)
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => { reject(new Error(`diagnostics request timed out after ${ms}ms`)) }, ms)
      if (signal !== undefined) {
        signal.addEventListener('abort', () => {
          if (timeoutId !== undefined) clearTimeout(timeoutId)
          reject(abortError(signal))
        }, { once: true })
      }
    })
    try {
      const result = await Promise.race([promise, timeoutPromise])
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      return result
    } catch (error) {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      throw error
    }
  }

  private async waitForRegistrationChange(timeout: number, signal?: AbortSignal): Promise<boolean> {
    if (timeout <= 0) return false
    if (signal?.aborted) throw abortError(signal)
    return new Promise<boolean>((resolve, reject) => {
      let finished = false
      const finish = (result: boolean): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        this.registrationListeners.delete(listener)
        resolve(result)
      }
      const listener = (): void => { finish(true) }
      this.registrationListeners.add(listener)
      const timer = setTimeout(() => { finish(false) }, timeout)
      if (signal !== undefined) {
        signal.addEventListener('abort', () => {
          finish(false)
          reject(abortError(signal))
        }, { once: true })
      }
    })
  }

  private async waitForFreshPush(request: {
    uri: string
    version: number
    after: number
    timeout: number
    signal?: AbortSignal | undefined
  }): Promise<boolean> {
    if (request.timeout <= 0) return false
    if (request.signal?.aborted) throw abortError(request.signal)
    return new Promise<boolean>((resolve, reject) => {
      let finished = false
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean): void => {
        if (finished) return
        finished = true
        if (debounceTimer !== undefined) clearTimeout(debounceTimer)
        clearTimeout(timeoutTimer)
        this.diagnosticListeners.delete(listener)
        resolve(result)
      }
      const schedule = (): void => {
        const hit = this.published.get(request.uri)
        if (hit === undefined) return
        if (typeof hit.version === 'number' && hit.version !== request.version) return
        if (hit.at < request.after && hit.version !== request.version) return
        if (debounceTimer !== undefined) clearTimeout(debounceTimer)
        const elapsed = Date.now() - hit.at
        const delay = Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - elapsed)
        debounceTimer = setTimeout(() => { finish(true) }, delay)
      }
      const listener = (event: { uri: string }): void => {
        if (event.uri !== request.uri) return
        schedule()
      }
      this.diagnosticListeners.add(listener)
      const timeoutTimer = setTimeout(() => { finish(false) }, request.timeout)
      if (request.signal !== undefined) {
        const signal = request.signal
        signal.addEventListener('abort', () => {
          finish(false)
          reject(abortError(signal))
        }, { once: true })
      }
      schedule()
    })
  }

  private async waitForDocumentDiagnostics(request: {
    path: string
    version: number
    after: number
    signal?: AbortSignal | undefined
  }): Promise<void> {
    const startedAt = request.after
    const pushWait = this.waitForFreshPush({
      uri: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
      signal: request.signal,
    })
    while (Date.now() - startedAt < DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS) {
      if (request.signal?.aborted) throw abortError(request.signal)
      const result = await this.requestDocumentDiagnostics(request.path, request.signal)
      if (result.matched) return
      const remaining = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then(ready => (ready ? 'push' as const : 'timeout' as const)),
        this.waitForRegistrationChange(remaining, request.signal).then(changed => (changed ? 'registration' as const : 'timeout' as const)),
      ])
      if (next !== 'registration') return
    }
  }

  private async waitForFullDiagnostics(request: {
    path: string
    version: number
    after: number
    signal?: AbortSignal | undefined
  }): Promise<void> {
    const startedAt = request.after
    const pushWait =
      request.path !== ''
        ? this.waitForFreshPush({
          uri: request.path,
          version: request.version,
          after: startedAt,
          timeout: DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
          signal: request.signal,
        })
        : Promise.resolve(false)
    while (Date.now() - startedAt < DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS) {
      if (request.signal?.aborted) throw abortError(request.signal)
      const result = await this.requestFullDiagnostics(request.path, request.signal)
      if (result.handled || result.matched) return
      const remaining = DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then(ready => (ready ? 'push' as const : 'timeout' as const)),
        this.waitForRegistrationChange(remaining, request.signal).then(changed => (changed ? 'registration' as const : 'timeout' as const)),
      ])
      if (next !== 'registration') return
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      this.handlePublishDiagnostics(params)
      return
    }
    // Other notifications are ignored but still considered observed
  }

  private handlePublishDiagnostics(params: unknown): void {
    if (params === null || typeof params !== 'object') return
    const rec = params as WirePublishDiagnosticsParams
    if (typeof rec.uri !== 'string' || !Array.isArray(rec.diagnostics)) return
    const uri = rec.uri
    if (typeof rec.version === 'number') {
      this.published.set(uri, { at: Date.now(), version: rec.version })
    } else {
      this.published.set(uri, { at: Date.now() })
    }
    const normalized = normalizeDiagnostics(rec.diagnostics as readonly WireDiagnostic[], uri)
    const deduped = dedupeDiagnostics(normalized)
    const capped = deduped.length > MAX_PER_FILE ? deduped.slice(0, MAX_PER_FILE) : deduped
    // Seed first push for typescript without firing listeners (opencode client.ts:167-169) so waitForFreshPush can resolve immediately
    const shouldSeed = shouldSeedForSpec(this.spec) && !this.pushDiagnostics.has(uri)
    if (shouldSeed) {
      this.pushDiagnostics.set(uri, capped)
      return
    }
    this.pushDiagnostics.set(uri, capped)
    for (const listener of this.diagnosticListeners) listener({ uri })
  }

  private async initialize(): Promise<void> {
    const result = (await this.connection.request('initialize', {
      processId: null,
      rootUri: this.spec.workspaceUri,
      workspaceFolders: [{ uri: this.spec.workspaceUri, name: 'workspace' }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.spec.initializationOptions,
    })) as WireInitializeResult
    const capabilities = result.capabilities
    negotiatePositionEncoding(capabilities.positionEncoding)
    this.capabilities = capabilities
    this.syncKind = getSyncKind(capabilities)
    this.hasStaticPullDiagnostics = Boolean(capabilities.diagnosticProvider)
    await this.connection.notify('initialized', {})
    if (this.spec.initializationOptions !== null && this.spec.initializationOptions !== undefined) {
      await this.connection.notify('workspace/didChangeConfiguration', {
        settings: this.spec.initializationOptions,
      })
    }
  }

  private answerServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'workspace/configuration') {
      const record = params as { items?: unknown[] } | null
      const items = Array.isArray(record?.items) ? record.items : []
      return Promise.resolve(items.map(() => this.spec.configuration))
    }
    if (method === 'client/registerCapability') {
      const rec = params as { registrations?: WireCapabilityRegistration[] } | null
      const registrations = Array.isArray(rec?.registrations) ? rec.registrations : []
      let changed = false
      for (const reg of registrations) {
        if (reg.method !== 'textDocument/diagnostic') continue
        this.diagnosticRegistrations.set(reg.id, reg)
        changed = true
      }
      if (changed) for (const l of [...this.registrationListeners]) l()
      return Promise.resolve(null)
    }
    if (method === 'client/unregisterCapability') {
      const rec = params as { unregisterations?: { id: string; method: string }[] } | null
      const regs = Array.isArray(rec?.unregisterations) ? rec.unregisterations : []
      let changed = false
      for (const reg of regs) {
        if (reg.method !== 'textDocument/diagnostic') continue
        if (this.diagnosticRegistrations.delete(reg.id)) changed = true
      }
      if (changed) for (const l of [...this.registrationListeners]) l()
      return Promise.resolve(null)
    }
    if (method === 'workspace/workspaceFolders') {
      return Promise.resolve([{ uri: this.spec.workspaceUri, name: 'workspace' }])
    }
    if (method === 'workspace/diagnostic/refresh') {
      return Promise.resolve(null)
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) {
      return Promise.resolve(null)
    }
    if (method === 'workspace/applyEdit') {
      return Promise.reject(new Error('workspace/applyEdit is not permitted by this host'))
    }
    return Promise.reject(new Error(`unsupported server request: ${method}`))
  }

  /** Dispose the instance: graceful shutdown/exit with escalation, then confirm process-tree exit. */
  async dispose(): Promise<void> {
    await this.startTeardown()
  }

  private startTeardown(): Promise<void> {
    this.disposed = true
    this.teardownPromise ??= this.tearDown()
    return this.teardownPromise
  }

  private async tearDown(): Promise<void> {
    const shutdownDeadline = deadline(undefined, this.spec.shutdownTimeoutMs, 'LSP_SHUTDOWN')
    try {
      await this.gracefulShutdown(shutdownDeadline.signal)
    } catch {
      // graceful shutdown failed — force terminate below
    } finally {
      shutdownDeadline[Symbol.dispose]()
    }
    await this.forceTerminate()
    // Close all open documents (best-effort didClose)
    for (const uri of this.files.keys()) {
      try {
        await this.connection.notify('textDocument/didClose', { textDocument: { uri } })
      } catch {
        // ignore
      }
    }
    this.files.clear()
  }

  private async gracefulShutdown(signal: AbortSignal): Promise<void> {
    await abortable(this.connection.request('shutdown', null), signal)
    await this.connection.notify('exit', null)
    await abortable(this.connection.closed, signal)
  }

  private async forceTerminate(): Promise<void> {
    this.connection.terminate()
    await Promise.all([this.connection.closed, this.connection.waitForProcessTreeExit()])
  }
}

const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

function getSyncKind(capabilities: WireServerCapabilities): number | undefined {
  const sync = capabilities.textDocumentSync
  if (sync === undefined) return undefined
  if (typeof sync === 'number') return sync
  return (sync as { change?: number }).change
}

function endPosition(text: string): { line: number; character: number } {
  const lines = text.split(/\r\n|\r|\n/)
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 }
}

function languageIdForUri(uri: string, mapping: Readonly<Record<string, string>>): string {
  try {
    const url = new URL(uri)
    const pathname = url.pathname
    const dot = pathname.lastIndexOf('.')
    if (dot < 0) return 'plaintext'
    const ext = pathname.slice(dot).toLowerCase()
    return mapping[ext] ?? 'plaintext'
  } catch {
    return 'plaintext'
  }
}

function shouldSeedForSpec(spec: DiagnosticsInstanceSpec): boolean {
  return spec.extensionToLanguage['.ts'] === 'typescript' || spec.extensionToLanguage['.tsx'] === 'typescript'
}

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeWatchedFiles: { dynamicRegistration: true },
    diagnostics: { refreshSupport: false },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didOpen: true, didChange: true },
    diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
    publishDiagnostics: { versionSupport: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const
