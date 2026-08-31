---
description: "The model-facing lsp-diagnostics tool: one read-only snapshot pull with 5 files×20 per file capping, severity 1 default, and bounded rendering, for users and maintainers composing diagnostics."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-lsp-diagnostics

English | [中文](README.zh.md)

## Summary

`dsh-tool-lsp-diagnostics` gives the model a single read-only `lsp-diagnostics` tool for pulling the current workspace diagnostics snapshot. The tool owns everything the model sees — name, schema, prompt guidance, result formatting, and UI presentation — and never depends on which language server backs a query. By default it shows only errors (severity 1), capped to 5 files × 20 diagnostics per file and bounded to 16 000 characters, with explicit omission and truncation markers. Compose it with a provider such as `dsh-lsp-stdio-diagnostics` and the `dsh-lsp-diagnostics` seam to surface diagnostics; call it after writes to check for compile errors without rediscovering them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

An agent uses `lsp-diagnostics` after writing files to pull the debounced diagnostics snapshot — not a live push stream — and decide whether to fix, explain, or continue. The tool's prompt guidance tells it to prefer this pull after writes and to filter with `file_path` when checking one file.

### The tool

`lsp-diagnostics` takes optional `file_path` (relative to the workspace or absolute; when omitted, returns the workspace snapshot capped to 5 files). The workspace root comes from the session `header.cwd` and is never model-configurable. Provider choice, limits, timeout, and executable stay outside model input.

### What the model gets back

Diagnostics render as `<diagnostics file="...">` blocks, one per file, each listing `SEVERITY [line:col] message` lines (one-based UTF-16 for the model; sort and dedup already applied by the provider). Results are filtered to severity 1 (Error) by default, capped first by `maxPerFile` (20), then by `maxFiles` (5), and finally by `maxResultChars` (16 000) with omission and truncation markers inside the complete cap. Empty snapshots are a successful `No diagnostics.` response.

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxFiles` | `5` | Largest number of files in the result before an omission marker (`write.ts:18`) |
| `maxPerFile` | `20` | Largest diagnostics per file before `... and N more` (`diagnostic.ts:1`) |
| `maxResultChars` | `16000` | Largest complete rendered result, including truncation metadata |
| `timeoutMs` | `10000` | Tool-call timeout budget enforced by `dsh-tool-call-timeout-policy`; covers the snapshot pull and is not model-configurable |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-lsp-diagnostics) is the exhaustive source for every accepted field.

### Failures and recovery

The tool requires a session workspace root (`header.cwd`) with no fallback; absence fails with `LSP_WORKSPACE_REQUIRED` before any query. When no provider is registered, the pull fails with `LSP_UNAVAILABLE`; malformed provider payloads remain structured `LSP_MALFORMED_RESPONSE` errors. These surface to the model as error tool results it can read and route on.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and where the code realizes them; observable behavior is covered in [Use this package](#use-this-package).

### Design notes

- **Consumer-only.** The tool runtime-injects only `tools`, `lspDiagnostics`, and `systemPrompt`, imports no provider, and passes only `exec.signal` to the seam.
- **Workspace root from session.** `sessionCwd(exec)` derives `workspaceRoot` from `header.cwd`; absence throws `LSP_WORKSPACE_REQUIRED`.
- **Severity filter and caps.** Execution filters snapshot diagnostics to severity 1 (`d.severity ?? 1 === 1`), then caps per-file with `maxPerFile` and cross-file with `maxFiles`; rendering caps `maxResultChars` last, mirroring opencode `diagnostic.ts` and `write.ts:18`.
- **Canonical result passthrough.** The tool returns `{ kind: 'diagnostics', diagnostics: [{ file, diagnostics: LspDiagnostic[] }] }` so native renderers can inspect every file bucket and zero-based range directly.
- **Bounded rendering.** `formatDiagnostics` joins per-file `report()` blocks (`<diagnostics file="...">`), applies omission (`… N more files omitted`) and truncation (`… diagnostics truncated`) markers inside the 16 000 cap, and returns `No diagnostics.` for empty or severity-filtered empties.
- **Generic search-card presentation.** `presentDiagnosticsCall` renders a `{ card: 'generic', kind: 'search', title, locations: [{ path, line }] }` view; the title carries `LSP diagnostics workspace` or `LSP diagnostics <file_path>`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, tool registration, system-prompt section, execution and severity/cap logic |
| [`src/render.ts`](src/render.ts) | Pure formatting, `prettyDiagnostic`/`report`/`formatDiagnostics`, caps, truncation, UI presentation |
| [`src/session-cwd.ts`](src/session-cwd.ts) | Workspace root from the session `header.cwd` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; stateless adapter) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the model-facing surface to the seam, the provider, and the decision evidence.

- [LSP navigation subsystem](../../../docs/subsystems/lsp.md) — diagnostics seam, snapshot, push observation, and `LspError` codes.
- [dsh-lsp-diagnostics](../lsp-diagnostics/README.md) — the seam this tool queries.
- [dsh-lsp-stdio-diagnostics](../lsp-stdio-diagnostics/README.md) — the stdio provider that answers these queries.
- [lsp group map](../README.md) — the six-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

One system-prompt section (first-party order 2200) positions diagnostics as a pull snapshot with the following text:

##### Verbatim guidance

```markdown
Use lsp-diagnostics to pull the current diagnostics snapshot after writes. It returns the debounced snapshot (errors only by default, 5 files×20 per file, capped) — not a live push stream. Filter with file_path for one file; omit for workspace.
```

#### Token effect

Fixed guidance cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schema

#### What the model sees

The model sees the generated [`lsp-diagnostics` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-lsp-diagnostics).

#### Token effect

Fixed schema cost on every request while enabled; the `timeoutMs` budget is never sent to the model.

#### KV Cache effect

Prefix-stable while the visible tool definition and order are unchanged; registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results

#### What the model sees

`<diagnostics file="...">` blocks with `SEVERITY [line:col] message` lines, filtered to severity 1 and capped first by `maxPerFile` (20), then by `maxFiles` (5), and finally by `maxResultChars` (16 000); omission and truncation markers are included inside the complete cap. Empty snapshots use distinct `No diagnostics.` line.

#### Token effect

Capped per tool result by `maxResultChars`, with `maxFiles` and `maxPerFile` additionally bounding item count.

#### KV Cache effect

Tool results append after the cached request prefix and do not directly invalidate it.

### UI presentation

#### What the model sees

Nothing. The client renders a generic search card — `{ card: 'generic', kind: 'search', title, locations: [{ path, line }] }` — whose title carries `LSP diagnostics workspace` or `LSP diagnostics <file_path>`.

#### Token effect

Zero direct token effect because rendering is client-side only.

#### KV Cache effect

None; UI presentation is outside the model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tool is a poor fit. They are current package constraints, not a task backlog.

- **Errors-only default** — the tool shows only severity 1 diagnostics by default; warnings, info, and hints are filtered before presentation to keep snapshots small.
- **Capped snapshot presentation** — 5 files × 20 per file plus 16 000 characters bounds what the model reads; full snapshots remain in the seam for native consumers.
- **No live push stream** — the tool is pull-only; `onDiagnostics` pushes are consumed internally by the provider and seam, not streamed as tool results.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
