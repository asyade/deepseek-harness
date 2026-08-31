# LSP navigation

English | [中文](lsp.zh.md)

The LSP seam — a [capability seam](../glossary.md#capability-seam) exposing semantic code navigation on one `ctx.lsp` service, split across packages: Service Definition ([dsh-lsp](../../packages/lsp/lsp), `ctx.lsp` + the provider registry), a generic Service Provider ([dsh-lsp-stdio](../../packages/lsp/lsp-stdio), a configured stdio language-server host), and Consumer ([dsh-tool-lsp](../../packages/lsp/tool-lsp), the `lsp` tool schema). LSP is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A provider swap does not change how the model asks for navigation.

Source: [`packages/lsp/lsp/src/types.ts`](../../packages/lsp/lsp/src/types.ts)

## Operations and coordinates

The seam and model expose exactly four semantic queries; the union is closed, so adding one is a compile-enforced change across the seam, providers, and the tool. Positions and ranges are zero-based UTF-16, matching the protocol; the model-facing tool owns the one-based cursor convention and converts on the way in and out.

```ts type-equiv
/**
 * The four semantic queries the seam and model expose. A closed union: adding an operation is a
 * compile-enforced change across the seam, providers, and the tool. Symbols and call hierarchy are
 * not operations here; they need different schemas.
 */
type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'
```

```ts type-equiv
/** A zero-based UTF-16 cursor coordinate, matching the LSP wire convention. */
interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}
```

```ts type-equiv
/** A zero-based UTF-16 half-open range `[start, end)`. */
interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}
```

## Request

Every field is required: `workspaceRoot` is caller-supplied, `languageId` comes from the provider's registration (not the request), and consumers own timeouts and result limits — so no field needs implementation defaulting and there is no `resolve()` step. The provider receives the caller's request plus the derived `languageId`, which only synchronizes the transient document and never participates in selection.

```ts type-equiv
/**
 * A caller's normalized query. Every field is required: `workspaceRoot` is caller-supplied,
 * `languageId` comes from the provider registration (not here), and consumers own timeouts and
 * result limits — so no field needs implementation defaulting and there is no `resolve()` step.
 */
interface LspQueryRequest {
  /** Which semantic query to run. */
  readonly operation: LspOperation
  /** The source file to query (relative to `workspaceRoot` or absolute; the provider canonicalizes). */
  readonly filePath: string
  /** The zero-based UTF-16 cursor position to query at. */
  readonly position: LspPosition
  /** The workspace root the provider resolves against and indexes; required, never defaulted. */
  readonly workspaceRoot: string
}
```

```ts type-equiv
/**
 * A request as a provider receives it: the caller's {@link LspQueryRequest} plus the `languageId`
 * the seam derived from the provider's extension mapping. The language id only synchronizes the
 * transient document; it does not participate in selection.
 */
interface LspProviderQuery extends LspQueryRequest {
  /** The LSP language id for `filePath`, from this provider's extension mapping. */
  readonly languageId: string
}
```

## Result

A CLOSED discriminated union: navigation operations normalize to `locations`, `hover` to content or `null`. Consumers `switch` on `kind` to exhaustiveness so a new arm breaks compilation until handled. `findReferences` always includes declarations — the provider enforces this internally, so callers get no flag. The `locations` variant carries `resolvedWorkspaceUri`, the provider's canonical workspace `file:` URI. A caller relativizing location URIs uses that coordinate rather than applying host-platform path rules to the possibly-symlinked request root.

```ts type-equiv
/** One resolved location: a document URI and the range within it. */
interface LspLocation {
  /** The target document URI (`file:` or otherwise), verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
}
```

```ts type-equiv
/** Normalized hover content, or `null` for no hover at the position. */
interface LspHover {
  /** The normalized hover text (markdown or plaintext, provider-joined). */
  readonly contents: string
  /** The range the hover applies to, when the server supplied one. */
  readonly range?: LspRange
}
```

```ts type-equiv
/**
 * The closed result union. Navigation operations (`goToDefinition`, `findReferences`,
 * `goToImplementation`) normalize to `locations`; `hover` normalizes to content or `null`.
 * Consumers `switch` on `kind` to exhaustiveness so a new arm breaks compilation until handled.
 *
 * The `locations` variant carries `resolvedWorkspaceUri`: the provider's canonical `file:` URI for
 * the request's workspace root. A caller that relativizes location URIs MUST use this, not parse the
 * request's possibly symlinked process path with host-platform rules; the execution platform may
 * differ from the caller's.
 */
type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }
```

## Provider and service

A provider owns a stable branded `id` and an exclusive lowercase leading-dot extension map. `registerProvider` reserves the id and every extension atomically — an invalid or conflicting registration publishes nothing — and its disposer releases all reservations. Selection is per query and order-independent; no match throws `LspError` `LSP_UNAVAILABLE`. The seam exposes no protocol types, process/document controls, or generic JSON-RPC escape hatch.

```ts type-equiv
/**
 * A language-server backend registered on `ctx.lsp`. Each provider owns a stable {@link
 * LspProviderId} and an extension-to-language-id map (lowercase, leading-dot keys).
 * `findReferences` always includes declarations — the provider enforces this internally; callers
 * get no flag.
 */
interface LspProvider {
  /** Stable provider identity, reserved atomically with the extension mappings. */
  readonly id: LspProviderId
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /**
   * Run one query. The seam has already selected this provider and derived `languageId`.
   * @param request - the resolved provider query (caller request + derived language id).
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
}
```

```ts type-equiv
/**
 * The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query
 * execution; exposes exactly the four operations and no protocol escape hatch.
 */
interface LspService {
  /**
   * Register a provider, atomically reserving its id and every normalized extension. Any conflict
   * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
   * reservations. Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the id and all extension reservations.
   */
  registerProvider(provider: LspProvider): () => void
  /**
   * Select a provider by the file's extension and run one query. Selection is per-query and
   * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
   * @param request - the normalized query.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
}
```

`LspProviderId` is the seam's branded id (`Branded<'LspProviderId'>` from [dsh-brand](../../packages/util/brand)); `LspError` extends `HarnessError` with stable codes such as `LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, `LSP_UNAVAILABLE`, `LSP_DISPOSED`, `LSP_UNSUPPORTED_OPERATION`, and `LSP_MALFORMED_RESPONSE`, which callers route on instead of parsing `message`.

## Diagnostics

The diagnostics seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-07-15-lsp-capability-seam.md) exposing workspace-scoped diagnostics on one `ctx.lspDiagnostics` service, split across packages: Service Definition ([dsh-lsp-diagnostics](../../packages/lsp/lsp-diagnostics), `ctx.lspDiagnostics` + the provider registry), a generic Service Provider ([dsh-lsp-stdio-diagnostics](../../packages/lsp/lsp-stdio-diagnostics), a configured stdio diagnostics host), and Consumer ([dsh-tool-lsp-diagnostics](../../packages/lsp/tool-lsp-diagnostics), the `lsp-diagnostics` tool schema). Diagnostics is **one optional capability** alongside navigation, not part of the agent-loop spine. A provider swap does not change how the model asks for diagnostics.

Source: [`packages/lsp/lsp-diagnostics/src/types.ts`](../../packages/lsp/lsp-diagnostics/src/types.ts)

### Diagnostic record

Diagnostics are normalized per-file records with zero-based UTF-16 ranges; severity follows the LSP `DiagnosticSeverity` enum (1 Error, 2 Warning, 3 Information, 4 Hint). Dedup mirrors opencode `client.ts:91-105` (`JSON.stringify({ code, severity, message, source, range })`) before capping; the seam itself does not enforce caps — providers do.

```ts type-equiv
/**
 * One normalized diagnostic. The `range` is zero-based UTF-16; `severity` uses the LSP
 * DiagnosticSeverity codes 1|2|3|4 (Error, Warning, Info, Hint). `code` and `source` are opaque
 * provider metadata; `message` is human-readable. Dedup is by
 * `JSON.stringify({ code, severity, message, source, range })` (opencode `client.ts:91-105`).
 */
interface LspDiagnostic {
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
```

### Snapshot

A per-workspace snapshot groups diagnostics by file and carries a monotonic commit timestamp. `byFile` is a read-only map (empty means no diagnostics); `workspaceRoot` is the canonical root the snapshot belongs to, and `at` marks commit time (e.g. `Date.now()`).

```ts type-equiv
/**
 * A per-workspace diagnostics snapshot. `byFile` is a read-only map from normalized file URI or
 * file path to the diagnostics for that file (empty map means no diagnostics). `at` is a
 * monotonic timestamp (e.g. `Date.now()`) marking snapshot commit time. `workspaceRoot` is the
 * canonical workspace root the snapshot belongs to.
 */
interface LspDiagnosticsSnapshot {
  /** Canonical workspace root this snapshot was collected for. */
  readonly workspaceRoot: string
  /** Diagnostics grouped by file (key is file URI or absolute path, verbatim from provider). */
  readonly byFile: ReadonlyMap<string, readonly LspDiagnostic[]>
  /** Millisecond timestamp of snapshot creation/commit. */
  readonly at: number
}
```

### Request

Every query is workspace-scoped; an optional `filePath` narrows the snapshot to one file (the seam still canonicalizes `workspaceRoot` and filters when the provider returns workspace-wide data).

```ts type-equiv
/**
 * The request for a diagnostics snapshot. Every query is workspace-scoped; `filePath` optionally
 * narrows to a single file (provider may still return workspace-wide data and the seam filters).
 */
interface LspDiagnosticsRequest {
  /** The workspace root to query (relative or absolute; the seam canonicalizes it). */
  readonly workspaceRoot: string
  /** Optional file path to narrow the snapshot to one file (relative to workspaceRoot or absolute). */
  readonly filePath?: string
}
```

### Provider and service

A diagnostics provider owns a stable branded `id`; there is no per-extension map — selection is by canonical `workspaceRoot` (a `canonicalizeWorkspace` copy from `packages/lsp/lsp-stdio/src/host.ts:32-59` without `ctx.fs`). `registerProvider` reserves the id atomically; `diagnostics` pulls one fresh snapshot, and `onDiagnostics` subscribes to debounced full-snapshot pushes (not incremental patches). The seam exposes no protocol types, process/document controls, or generic JSON-RPC escape hatch.

```ts type-equiv
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
interface LspDiagnosticsProvider {
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
```

```ts type-equiv
/**
 * The diagnostics capability seam (`ctx.lspDiagnostics`). Owns provider registration, workspace-
 * canonical selection, normalized snapshot query, and push observation. Exposes no protocol escape
 * hatch and no extension map.
 */
interface LspDiagnosticsService {
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
```

### Tool `lsp-diagnostics`

The model-facing tool over `ctx.lspDiagnostics` is a single read-only `lsp-diagnostics` pull: it takes optional `file_path`, derives `workspaceRoot` from the session `header.cwd` (no fallback), filters the snapshot to severity 1 (Error) by default, caps to 5 files × 20 per file, and bounds rendering to 16 000 characters with omission and truncation markers. Push observation (`onDiagnostics`) is not streamed as tool results — the tool is pull-only, while the provider and seam handle debounced pushes internally. The tool registers on `ctx.tools` and contributes one system-prompt section; see [dsh-tool-lsp-diagnostics](../../packages/lsp/tool-lsp-diagnostics/README.md) and [the tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-lsp-diagnostics).

`LspDiagnosticsProviderId` is the seam's branded id (`Branded<'LspDiagnosticsProviderId'>` from [dsh-brand](../../packages/util/brand)); `LspError` (`LspDiagnosticsError` alias) extends `HarnessError` with stable codes `LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, and `LSP_UNAVAILABLE`.

### Clippy via LSP — deployment example

Clippy lints ride the same `ctx.lspDiagnostics` push-feed with no new seam — the provider only needs `rust-analyzer` configured to run `clippy` instead of `cargo check` on `textDocument/didSave`. The debounced merge (`150 ms`), dedupe (`JSON.stringify({ code, severity, message, source, range })`), and caps (`20` per file, `5` files) apply unchanged; every clippy lint appears as `LspDiagnostic{severity 1|2, code, message, range}` and is pullable via the `lsp-diagnostics` tool (`severity:1` capped at `5×20`, `16 000` char render). See [GOAT research](../research/2026-08-31-goat-lint-diagnostics.md#24-extended-cargo-clippy-diagnostic--is-it-relevant) and the provider [README](../../packages/lsp/lsp-stdio-diagnostics/README.md#clippy-deployment-examples).

**rust-analyzer clippy (recommended for small workspaces):**

```yaml
- name: '@deepseek-ai/dsh-lsp-stdio-diagnostics'
  config:
    servers:
      rust-analyzer-clippy:
        command: rust-analyzer
        args: []
        extensionToLanguage: { '.rs': rust }
        initializationOptions:
          check:
            command: clippy
            extraArgs: ['--', '-W', 'clippy::pedantic']
          diagnostics: { enable: true }
```

Pin the toolchain in `clippy.toml` (or `[lints.clippy]` in `Cargo.toml`) so editor and CI agree; never enable `pedantic`/`nursery`/`restriction` wholesale in CI — whitelist 3–5 lints:

```toml
# clippy.toml
msrv = "1.78"
# or in Cargo.toml: [lints.clippy] pedantic = "warn"
```

CI gate (conditional — skips if no `Cargo.toml`):

```sh
cargo clippy --all-targets --all-features -- -D warnings
```

**bacon-ls cargo backend (GOAT for large workspaces with many targets):** `bacon` + `bacon-ls` runs `cargo clippy --message-format=json-diagnostic-rendered-ansi` per save/open/close and publishes `textDocument/publishDiagnostics` (+ pull `textDocument/diagnostic`) streaming every `refreshIntervalSeconds:5`. Requires `rust-analyzer.checkOnSave.enable=false` and `diagnostics.enable=false` to avoid double publish:

```yaml
- name: '@deepseek-ai/dsh-lsp-stdio-diagnostics'
  config:
    servers:
      bacon-ls:
        command: bacon-ls
        args: []
        extensionToLanguage: { '.rs': rust }
        initializationOptions:
          updateOnSave: true
          updateOnChange: true
          refreshIntervalSeconds: 5
```

Pick one per `workspaceRoot` — `rust-analyzer` and `bacon-ls` compete for `publishDiagnostics`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxlsp--lspservice"></a>

### `ctx.lsp` — `LspService`

The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query execution; exposes exactly the four operations and no protocol escape hatch.

```ts cordis-catalog
/**
 * Register a provider, atomically reserving its id and every normalized extension. Any conflict
 * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
 * reservations. Disposed with the calling fiber.
 * @param provider - the backend to register.
 * @returns a synchronous disposer releasing the id and all extension reservations.
 */
registerProvider(provider: LspProvider): () => void

/**
 * Select a provider by the file's extension and run one query. Selection is per-query and
 * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
 * @param request - the normalized query.
 * @param signal - optional cancellation forwarded to the selected provider.
 * @returns the normalized, closed-union result.
 */
query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
```

Source: [`packages/lsp/lsp/src/types.ts`](../../packages/lsp/lsp/src/types.ts)

<a id="ctxlspdiagnostics--lspdiagnosticsservice"></a>

### `ctx.lspDiagnostics` — `LspDiagnosticsService`

The diagnostics capability seam (`ctx.lspDiagnostics`). Owns provider registration, workspace- canonical selection, normalized snapshot query, and push observation. Exposes no protocol escape hatch and no extension map.

```ts cordis-catalog
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
```

Source: [`packages/lsp/lsp-diagnostics/src/types.ts`](../../packages/lsp/lsp-diagnostics/src/types.ts)
<!-- END GENERATED cordis-surface -->
