# LSP 导航

[English](lsp.md) | 中文

LSP seam 是一个[能力 seam](../glossary.zh.md#capability-seam)：它在单一 `ctx.lsp` 服务上公开语义代码导航，并拆分到多个包：Service Definition（[dsh-lsp](../../packages/lsp/lsp)，`ctx.lsp` + 提供方注册表）、通用 Service Provider（[dsh-lsp-stdio](../../packages/lsp/lsp-stdio)，经过配置的 stdio 语言服务器宿主）和 Consumer（[dsh-tool-lsp](../../packages/lsp/tool-lsp)，即 `lsp` 工具 schema）。LSP 是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此而非 [core.md](core.zh.md) 中。更换提供方不会改变模型请求导航的方式。

源文件：[`packages/lsp/lsp/src/types.ts`](../../packages/lsp/lsp/src/types.ts)

## 操作与坐标

seam 与模型恰好公开 4 项语义查询；该联合是闭合的，因此新增一项查询会通过编译强制要求同步修改 seam、提供方和工具。位置与范围采用从零开始的 UTF-16 坐标，与协议一致；面向模型的工具采用从 1 开始的光标约定，并在输入和输出时进行转换。

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

## 请求

每个字段都是必填项：`workspaceRoot` 由调用方提供，`languageId` 来自提供方注册而非请求，超时与结果上限由消费方决定。因此没有字段需要由实现提供默认值，也不存在 `resolve()` 步骤。提供方收到调用方请求和派生的 `languageId`；后者只用于同步瞬态文档，从不参与选择。

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

## 结果

这是一个闭合的可辨识联合：导航操作规范化为 `locations`，`hover` 规范化为内容或 `null`。消费方使用 `switch` 对 `kind` 做穷尽处理，因此新增分支会使编译失败，直到完成处理。`findReferences` 始终包含声明；提供方在内部强制保证这一点，因此调用方没有对应 flag。`locations` 变体携带 `resolvedWorkspaceUri`，即提供方的规范工作区 `file:` URI。调用方相对化位置 URI 时应使用这一坐标，而不是对可能经过符号链接的请求根目录应用宿主平台路径规则。

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

## 提供方与服务

每个提供方拥有一个稳定的品牌化 `id`，以及一份互斥的、小写且以点开头的扩展名映射。`registerProvider` 会原子预留 id 和每个扩展名：注册无效或冲突时不发布任何内容；其 disposer 会释放所有保留项。每次查询独立选择提供方，且选择与顺序无关；没有匹配项时抛出 `LspError` `LSP_UNAVAILABLE`。该 seam 不公开协议类型、进程或文档控制，也不提供通用 JSON-RPC 逃生口。

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

`LspProviderId` 是该 seam 的品牌化 id（来自 [dsh-brand](../../packages/util/brand) 的 `Branded<'LspProviderId'>`）；`LspError` 扩展 `HarnessError`，提供 `LSP_INVALID_PROVIDER`、`LSP_CONFLICT`、`LSP_UNAVAILABLE`、`LSP_DISPOSED`、`LSP_UNSUPPORTED_OPERATION` 和 `LSP_MALFORMED_RESPONSE` 等稳定错误码，调用方应按错误码路由，而不是解析 `message`。

## 诊断

诊断 seam——一个[能力 seam](../../.agents/notes/archived/architecture/2026-07-15-lsp-capability-seam.md)，在单一 `ctx.lspDiagnostics` 服务上公开工作区范围的诊断，并拆分到多个包：Service Definition（[dsh-lsp-diagnostics](../../packages/lsp/lsp-diagnostics)，`ctx.lspDiagnostics` + 提供方注册表）、通用 Service Provider（[dsh-lsp-stdio-diagnostics](../../packages/lsp/lsp-stdio-diagnostics)，经过配置的 stdio 诊断宿主）和 Consumer（[dsh-tool-lsp-diagnostics](../../packages/lsp/tool-lsp-diagnostics)，即 `lsp-diagnostics` 工具 schema）。诊断是导航之外的**一项可选能力**，不属于 agent loop（智能体循环）主干。更换提供方不会改变模型请求诊断的方式。

源文件：[`packages/lsp/lsp-diagnostics/src/types.ts`](../../packages/lsp/lsp-diagnostics/src/types.ts)

### 诊断记录

诊断是规范化的按文件记录，使用基于零的 UTF-16 range；severity 遵循 LSP `DiagnosticSeverity` 枚举（1 Error、2 Warning、3 Information、4 Hint）。去重镜像 opencode `client.ts:91-105`（`JSON.stringify({ code, severity, message, source, range })`），然后才截断；seam 本身不强制截断——由提供方执行。

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

### 快照

按工作区的快照按文件分组诊断，并携带单调递增的提交时间戳。`byFile` 是只读映射（空映射表示无诊断）；`workspaceRoot` 是该快照所属的规范化根；`at` 标记提交时间（如 `Date.now()`）。

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

### 请求

每个查询都是工作区范围的；可选的 `filePath` 将快照收窄到单个文件（seam 仍会规范化 `workspaceRoot`，并在提供方返回工作区范围数据时进行过滤）。

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

### 提供方与服务

诊断提供方拥有稳定的品牌化 `id`；没有按扩展名的映射——选择依据是规范化的 `workspaceRoot`（从 `packages/lsp/lsp-stdio/src/host.ts:32-59` 复制 `canonicalizeWorkspace`，不依赖 `ctx.fs`）。`registerProvider` 原子化预留 id；`diagnostics` 拉取一份新鲜快照；`onDiagnostics` 订阅防抖后的全量快照推送（而非增量补丁）。seam 不暴露协议类型、进程/文档控制或通用 JSON-RPC 逃生口。

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

### 工具 `lsp-diagnostics`

`ctx.lspDiagnostics` 之上的模型面向工具是单一的只读 `lsp-diagnostics` 拉取：接受可选 `file_path`，从会话 `header.cwd` 推导 `workspaceRoot`（无回退），默认过滤到 severity 1（Error），截断为 5 文件 × 每文件 20 条，并将渲染限制在 16 000 字符以内，带省略与截断标记。推送观察（`onDiagnostics`）不流式化为工具结果——工具只拉取，推送的防抖处理由提供方与 seam 在内部完成。工具注册在 `ctx.tools` 上并贡献一个系统提示词小节；参见 [dsh-tool-lsp-diagnostics](../../packages/lsp/tool-lsp-diagnostics/README.zh.md) 与[工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-lsp-diagnostics)。

`LspDiagnosticsProviderId` 是该 seam 的品牌化 id（来自 [dsh-brand](../../packages/util/brand) 的 `Branded<'LspDiagnosticsProviderId'>`）；`LspError`（`LspDiagnosticsError` 别名）扩展 `HarnessError`，提供稳定错误码 `LSP_INVALID_PROVIDER`、`LSP_CONFLICT` 与 `LSP_UNAVAILABLE`。

<a id="clippy-via-lsp--deployment-example"></a>

### Clippy via LSP——部署示例

Clippy lint 走同一条 `ctx.lspDiagnostics` 推送流，无需新 seam——提供方只需将 `rust-analyzer` 配置为在 `textDocument/didSave` 时运行 `clippy` 而非 `cargo check`。防抖合并（`150 ms`）、去重（`JSON.stringify({ code, severity, message, source, range })`）与截断（每文件 `20` 条、`5` 个文件）保持不变；每个 clippy lint 都以 `LspDiagnostic{severity 1|2, code, message, range}` 出现，并可通过 `lsp-diagnostics` 工具拉取（`severity:1` 截断为 `5×20`、`16 000` 字符渲染）。参见 [GOAT 研究](../research/2026-08-31-goat-lint-diagnostics.zh.md#24-extended-cargo-clippy-diagnostic--is-it-relevant) 与提供方 [README](../../packages/lsp/lsp-stdio-diagnostics/README.zh.md#clippy-deployment-examples)。

**rust-analyzer clippy（小工作区推荐）：**

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

在 `clippy.toml`（或 `Cargo.toml` 的 `[lints.clippy]`）中固定工具链，使编辑器与 CI 一致；绝不在 CI 中整体启用 `pedantic`/`nursery`/`restriction`——白名单 3–5 个 lint：

```toml
# clippy.toml
msrv = "1.78"
# or in Cargo.toml: [lints.clippy] pedantic = "warn"
```

CI 门禁（条件式——无 `Cargo.toml` 时跳过）：

```sh
cargo clippy --all-targets --all-features -- -D warnings
```

**bacon-ls cargo 后端（多 target 大工作区的 GOAT）：** `bacon` + `bacon-ls` 在每次保存/打开/关闭时运行 `cargo clippy --message-format=json-diagnostic-rendered-ansi`，并发布 `textDocument/publishDiagnostics`（+ 拉取 `textDocument/diagnostic`），每 `refreshIntervalSeconds:5` 流式输出。需要 `rust-analyzer.checkOnSave.enable=false` 与 `diagnostics.enable=false` 以避免重复发布：

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

每个 `workspaceRoot` 选其一——`rust-analyzer` 与 `bacon-ls` 会竞争 `publishDiagnostics`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
