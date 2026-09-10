/**
 * Wire types for the diagnostics stdio host: re-exports navigation shapes from the base host and adds
 * diagnostics-specific protocol types (publishDiagnostics, textDocument/diagnostic, workspace/diagnostic).
 * @module @deepseek-ai/dsh-lsp-stdio-diagnostics/protocol
 */

/** A zero-based UTF-16 position on the wire (the protocol's `Position`). */
export interface WirePosition {
  readonly line: number
  readonly character: number
}

/** A wire range (`Range`). */
export interface WireRange {
  readonly start: WirePosition
  readonly end: WirePosition
}

/** A `Location`: a document URI plus a range. */
export interface WireLocation {
  readonly uri: string
  readonly range: WireRange
}

/** A `LocationLink`: the target uri plus the selection range to focus. */
export interface WireLocationLink {
  readonly targetUri: string
  readonly targetSelectionRange: WireRange
  readonly targetRange?: WireRange
}

/** A `MarkupContent` hover body (`markdown` or `plaintext`). */
export interface WireMarkupContent {
  readonly kind: 'markdown' | 'plaintext'
  readonly value: string
}

/** A `MarkedString` object form (`{ language, value }`); the string form is a bare `string`. */
export interface WireMarkedStringObject {
  readonly language: string
  readonly value: string
}

/** One `MarkedString`: a raw string or a language-tagged code block. */
export type WireMarkedString = string | WireMarkedStringObject

/** A `Hover`: contents in any of the protocol's three encodings, plus an optional range. */
export interface WireHover {
  readonly contents: WireMarkupContent | WireMarkedString | readonly WireMarkedString[]
  readonly range?: WireRange
}

/** The legacy enum form of `textDocumentSync` (`0` None, `1` Full, `2` Incremental). */
export type WireTextDocumentSyncKind = 0 | 1 | 2

/** The options form of `textDocumentSync` (`{ openClose, change }`). */
export interface WireTextDocumentSyncOptions {
  readonly openClose?: boolean
  readonly change?: WireTextDocumentSyncKind
}

/** A `ServerCapabilities.provider` slot: a boolean or an options object (both mean "supported"). */
export type WireProviderCapability = boolean | Record<string, unknown> | undefined

/** The `ServerCapabilities` fields this host inspects (navigation + diagnostics). */
export interface WireServerCapabilities {
  readonly positionEncoding?: string
  readonly textDocumentSync?: WireTextDocumentSyncKind | WireTextDocumentSyncOptions
  readonly definitionProvider?: WireProviderCapability
  readonly referencesProvider?: WireProviderCapability
  readonly implementationProvider?: WireProviderCapability
  readonly hoverProvider?: WireProviderCapability
  /** Static diagnostic provider (boolean or options); dynamic variant via client/registerCapability. */
  readonly diagnosticProvider?: WireProviderCapability
}

/** The `initialize` result envelope. */
export interface WireInitializeResult {
  readonly capabilities: WireServerCapabilities
}

// --- Diagnostics wire types ---

/** Severity level per LSP DiagnosticSeverity enum. */
export type WireDiagnosticSeverity = 1 | 2 | 3 | 4

/** A wire `Diagnostic`. */
export interface WireDiagnostic {
  readonly range: WireRange
  readonly severity?: WireDiagnosticSeverity
  readonly code?: string | number
  readonly source?: string
  readonly message: string
  readonly relatedInformation?: unknown
  readonly tags?: readonly number[]
}

/** Notification params for `textDocument/publishDiagnostics`. */
export interface WirePublishDiagnosticsParams {
  readonly uri: string
  readonly version?: number
  readonly diagnostics: readonly WireDiagnostic[]
}

/** Result of `textDocument/diagnostic`. */
export interface WireDocumentDiagnosticReport {
  readonly kind?: string
  readonly items?: readonly WireDiagnostic[]
  readonly relatedDocuments?: Record<string, WireDocumentDiagnosticReport>
}

/** One entry in `workspace/diagnostic` result. */
export interface WireWorkspaceDiagnosticItem {
  readonly uri?: string
  readonly items?: readonly WireDiagnostic[]
}

/** Result of `workspace/diagnostic`. */
export interface WireWorkspaceDiagnosticReport {
  readonly items?: readonly WireWorkspaceDiagnosticItem[]
}

/** Capability registration for dynamic `textDocument/diagnostic`. */
export interface WireCapabilityRegistration {
  readonly id: string
  readonly method: string
  readonly registerOptions?: {
    readonly identifier?: string
    readonly workspaceDiagnostics?: boolean
  }
}
