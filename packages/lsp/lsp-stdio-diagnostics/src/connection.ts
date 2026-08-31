/**
 * A JSON-RPC endpoint over one language server spawned through the subprocess
 * capability — fork of `@deepseek-ai/dsh-lsp-stdio/connection` that forwards
 * `textDocument/publishDiagnostics` notifications to the caller.
 * Owns id correlation, outbound requests/notifications, and inbound
 * server→client requests/notifications: it answers `workspace/configuration` from static
 * config, rejects `workspace/applyEdit`, caps stderr, surfaces framing/decoder
 * failures as a fatal close, and exposes tree-scoped termination through the handle.
 * @module @deepseek-ai/dsh-lsp-stdio-diagnostics/connection
 */

import type { Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { encodeMessage, MessageDecoder } from './framing.ts'

/** How to launch the server and answer its config requests. */
export interface ConnectionSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly maxMessageBytes: number
  readonly maxStderrBytes: number
  readonly killGraceMs: number
  readonly configuration: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Framed-write callback: encode `message` and write it to the connection's stdin, invoking `done` with any error. */
export type ConnectionWriter = (
  stdin: Writable,
  message: unknown,
  done: (error?: Error | null) => void,
) => void

/** Spawn callback: launch a child process from a subprocess spawn spec. */
export type ConnectionSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** Callback for server→client notifications (e.g. textDocument/publishDiagnostics). */
export type NotificationHandler = (method: string, params: unknown) => void

const writeConnectionMessage: ConnectionWriter = (stdin, message, done) => {
  stdin.write(encodeMessage(message), done)
}

/** A live JSON-RPC endpoint bound to one child process, with publishDiagnostics forwarding. */
export class LspConnection {
  private readonly handle: SubprocessHandle
  private readonly stdin: Writable
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closeReason: Error | undefined
  /** Resolves when the connection closes (process exit or transport failure), with the close reason. */
  readonly closed: Promise<void>
  private readonly onNotification: NotificationHandler | undefined
  private readonly writer: ConnectionWriter

  constructor(
    spec: ConnectionSpec,
    spawner: ConnectionSpawner,
    private readonly onServerRequest: (method: string, params: unknown) => Promise<unknown>,
    onNotificationOrWriter?: NotificationHandler | ConnectionWriter,
    writer?: ConnectionWriter,
  ) {
    // Disambiguate the overloaded 4th argument: a ConnectionWriter has arity 3 (stdin, message, done),
    // while a NotificationHandler has arity 2 (method, params). This keeps legacy 4-arg call sites
    // (spec, spawner, onServerRequest, writer) working if they were to reuse this class.
    let onNotification: NotificationHandler | undefined
    let resolvedWriter: ConnectionWriter | undefined
    if (onNotificationOrWriter !== undefined) {
      if (onNotificationOrWriter.length === 3) {
        resolvedWriter = onNotificationOrWriter as ConnectionWriter
      } else {
        onNotification = onNotificationOrWriter as NotificationHandler
        resolvedWriter = writer
      }
    } else {
      resolvedWriter = writer
    }
    this.onNotification = onNotification
    const effectiveWriter = resolvedWriter ?? writeConnectionMessage
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    this.handle = spawner({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: spec.maxStderrBytes },
      },
      graceMs: spec.killGraceMs,
      env: spec.env,
    })
    /* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
    if (this.handle.stdin === undefined || this.handle.stdout === undefined) {
      throw new Error('lsp-stdio-diagnostics: subprocess implementation dropped a piped protocol stream')
    }
    /* v8 ignore stop */
    this.stdin = this.handle.stdin
    this.closed = new Promise<void>((resolve) => {
      const close = (): void => {
        const reason = this.closeReason ?? new Error(this.exitMessage())
        this.closeReason = reason
        this.failAll(reason)
        resolve()
      }
      this.handle.done.then(close, (error: unknown) => {
        this.fail(asError(error))
        close()
      })
    })
    this.writer = effectiveWriter
    this.stdin.on('error', (error) => { this.fail(error) })
    this.handle.stdout.on('data', (chunk: Buffer) => { this.onStdout(chunk) })
  }

  /** The child process id. */
  get pid(): number {
    return this.handle.pid
  }

  /** Retained stderr tail (bounded by the connection's stderr cap). */
  get stderrTail(): string {
    /* v8 ignore next -- the collect disposition always exposes a stderr reader; defensive. */
    return this.handle.collected.stderr?.readFrom(0).text ?? ''
  }

  /** Whether the connection has closed with a failure. */
  get failed(): boolean {
    return this.closeReason !== undefined
  }

  /**
   * Whether the connection closed with exactly this error.
   * @param error - the error to compare against the recorded close reason.
   * @returns whether the close reason matches.
   */
  failedWith(error: unknown): boolean {
    return this.closeReason === error
  }

  /**
   * Send a JSON-RPC request and await the server's matching response.
   * @param method - the request method.
   * @param params - the request payload.
   * @returns the response result.
   */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.closeReason !== undefined) {
        reject(this.closeReason)
        return
      }
      this.pending.set(id, { resolve, reject })
      void this.write({ jsonrpc: '2.0', id, method, params }).catch(() => {})
    })
    promise.catch(() => {})
    return promise
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   * @param method - the notification method.
   * @param params - the notification payload.
   */
  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Send a `$/cancelRequest` notification for an outstanding request.
   * @param requestId - the request id to cancel.
   */
  cancel(requestId: number): void {
    void this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } }).catch(() => {})
  }

  /**
   * The next request id that will be assigned.
   * @returns the id the next `request` call will use.
   */
  peekNextId(): number {
    return this.nextId
  }

  /** Terminate the child process immediately. */
  terminate(): void {
    this.handle.terminate()
  }

  /**
   * Await the child process tree's exit.
   * @param signal - optional cancellation.
   * @returns whether the process tree exited.
   */
  async waitForProcessTreeExit(signal?: AbortSignal): Promise<boolean> {
    return await this.handle.waitForExit(signal)
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      this.fail(asError(error))
      this.handle.terminate()
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  private dispatch(message: unknown): void {
    if (message === null || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      /* v8 ignore next -- protocol tests exercise response writes; only a simultaneous connection
         failure makes this consumption handler run. */
      void this.handleServerRequest(id, method, frame.params).catch(() => {})
      return
    }
    if (typeof method === 'string') {
      // Server→client notification: forward to the diagnostics handler when present.
      // This is the publishDiagnostics path that the navigation-only host previously ignored.
      if (this.onNotification !== undefined) {
        try {
          this.onNotification(method, frame.params)
        } catch {
          // Notification handler must not break the dispatch loop; a throwing handler is a local bug.
        }
      }
      return
    }
    if (typeof id === 'number') this.handleResponse(id, frame)
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onServerRequest(method, params)
      await this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      await this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: asError(error).message } })
    }
  }

  private handleResponse(id: number, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = frame.error
    if (error !== null && typeof error === 'object') {
      const record = error as Record<string, unknown>
      pending.reject(new Error(typeof record.message === 'string' ? record.message : 'LSP error response'))
      return
    }
    pending.resolve(frame.result)
  }

  private write(message: unknown): Promise<void> {
    if (this.closeReason !== undefined) return Promise.reject(this.closeReason)
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null): void => {
        if (error === undefined || error === null) {
          resolve()
          return
        }
        this.fail(error)
        reject(error)
      }
      try {
        this.writer(this.stdin, message, done)
      /* v8 ignore start -- Node stream write failures are callback-delivered; this guards a
         nonconforming Writable implementation throwing synchronously. */
      } catch (error) {
        const failure = asError(error)
        this.fail(failure)
        reject(failure)
      }
      /* v8 ignore stop */
    })
  }

  private exitMessage(): string {
    const tail = this.stderrTail.trim()
    return tail === '' ? 'language server exited' : `language server exited; stderr: ${tail}`
  }

  private fail(error: Error): void {
    /* v8 ignore next -- the second arm (closeReason already set) needs two fail() calls before close; defensive. */
    if (this.closeReason === undefined) this.closeReason = error
    this.failAll(error)
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(error)
  }
}

function asError(value: unknown): Error {
  /* v8 ignore next -- the non-Error branch guards against a non-Error throw, which our paths never produce. */
  return value instanceof Error ? value : new Error(String(value))
}
