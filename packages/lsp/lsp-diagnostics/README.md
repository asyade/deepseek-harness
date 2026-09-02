---
description: "The diagnostics capability seam (ctx.lspDiagnostics): workspace-scoped snapshot query, push observation, and provider registry keyed by branded id, for users and maintainers composing diagnostics."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-diagnostics

English | [中文](README.zh.md)

## Summary

`dsh-lsp-diagnostics` provides the harness's diagnostics seam: an agent can pull the current workspace diagnostics snapshot or subscribe to debounced push snapshots, and the diagnostics service (`ctx.lspDiagnostics`) routes each query to the registered diagnostics provider. Providers register by branded id and are selected by canonical workspace root, so a provider swap never changes how diagnostics are requested or what the model sees. The service exposes only a typed snapshot and a push subscription — no JSON-RPC escape hatch, no document or process controls, and no per-extension map — and it contributes no prompt or tool schema itself — the model-facing `lsp-diagnostics` tool lives in `dsh-tool-lsp-diagnostics`. Compose it with a provider such as `dsh-lsp-stdio-diagnostics` and the tool to give agents pull diagnostics; this package does nothing on its own.

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

Mount a diagnostics provider and the `lsp-diagnostics` tool to give agents a bounded, severity-filtered view of workspace errors after writes — without rediscovering them by re-reading files. This package is the service those packages register against; it defines no UI, tool, or provider of its own.

### When to choose it

Choose this service when a deployment wants model-visible diagnostics backed by language servers. It covers workspace-scoped snapshots and debounced push observation — pull a fresh snapshot for a workspace, optionally narrowed to one file, or subscribe to full-snapshot pushes. It deliberately omits navigation, mutations, and protocol surface; selection is by canonical `workspaceRoot`, not by file extension.

### Composing a diagnostics stack

The seam needs a provider and a consumer to do anything. A minimal composition mounts the service, a stdio diagnostics provider, and the tool:

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-lsp-diagnostics'
- name: '@deepseek-ai/dsh-lsp-stdio-diagnostics'
  config:
    servers:
      typescript:
        command: typescript-language-server
        args: ['--stdio']
        extensionToLanguage:
          '.ts': typescript
- name: '@deepseek-ai/dsh-tool-lsp-diagnostics'
```

Server commands, extension mappings, and the filesystem/subprocess pairing are configured in the provider package; see [dsh-lsp-stdio-diagnostics](../lsp-stdio-diagnostics/README.md) and [dsh-tool-lsp-diagnostics](../tool-lsp-diagnostics/README.md).

### Snapshot and push

A snapshot (`LspDiagnosticsSnapshot`) groups diagnostics by file (`byFile: ReadonlyMap<string, readonly LspDiagnostic[]>`) and carries `workspaceRoot` and `at` (monotonic commit timestamp). A request (`LspDiagnosticsRequest`) supplies `workspaceRoot` and optionally `filePath`; the seam canonicalizes `workspaceRoot` (trim + trailing-separator normalization, `src/index.ts:canonicalizeWorkspaceRoot`) and delegates to the provider. The seam also forwards debounced full-snapshot pushes via `onDiagnostics`; providers coalesce rapid changes, and the tool uses only the pull path.

### Failures and recovery

A query fails with `LSP_UNAVAILABLE` when no provider is registered, and with `LSP_INVALID_PROVIDER` when `workspaceRoot` is empty after trimming. Invalid or conflicting provider registrations fail with `LSP_INVALID_PROVIDER` or `LSP_CONFLICT` before any route is published. Consumers catch `LspError` and route on its stable `code`; through the tool these surface as error results the model can read.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the seam and where the code realizes them; observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Capability seam, Service Definition role.** The package owns `ctx.lspDiagnostics` and the provider registry; providers register capabilities, not tools, and `dsh-tool-lsp-diagnostics` is the only owner of the model-facing surface.
- **Atomic registration.** `registerProvider()` validates and conflict-checks before mutating: an invalid or conflicting registration publishes nothing, and its disposer releases the id and any push forwarding together. For v1 a single global provider is allowed; a second registration conflicts.
- **Workspace-scoped selection.** `diagnostics()` canonicalizes `workspaceRoot` synchronously without `ctx.fs` (trim and trailing-separator normalization, mirroring `packages/lsp/lsp-stdio/src/host.ts:32-59`) and delegates to the sole provider; there is no per-extension map.
- **Closed snapshot vocabulary.** Diagnostic records, snapshots, and provider contracts live in `src/types.ts`; positions and ranges are zero-based UTF-16. Dedup mirrors opencode `client.ts:91-105` (`JSON.stringify({ code, severity, message, source, range })`) and caps (`MAX_PER_FILE=20`, cross-file 5) are provider-enforced, but consumers should treat results as already capped.
- **No protocol escape hatch.** The seam exposes no document or process controls and no generic JSON-RPC surface — only the typed snapshot and the push subscription.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `LspDiagnostics` service, `registerProvider`/`diagnostics`/`onDiagnostics`, `canonicalizeWorkspaceRoot`, `LspError` |
| [`src/types.ts`](src/types.ts) | Seam vocabulary: `LspDiagnostic`, `LspDiagnosticsSnapshot`, `LspDiagnosticsRequest`, provider and service contracts |
| [`src/brand.ts`](src/brand.ts) | `LspDiagnosticsProviderId` branded-id type and factory |
| — | No runtime invariant companion is published; provider ids and push subscriptions are private, atomically updated state with no independently observable snapshot. |

### Registration and lifecycle

Registration and disposal run through `ctx.effect()`, so provider routes and push forwarding live and die with the registering fiber. `canonicalizeWorkspaceRoot()` trims and strips trailing separators, rejecting empty input with `LSP_INVALID_PROVIDER`. `LspError` extends `HarnessError` with stable codes (`LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, `LSP_UNAVAILABLE`) that callers route on instead of parsing `message`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared diagnostics model to the provider, the tool, and the decision evidence.

- [LSP navigation subsystem](../../../docs/subsystems/lsp.md) — diagnostics seam, snapshot, push observation, and `LspError` codes.
- [dsh-lsp-stdio-diagnostics](../lsp-stdio-diagnostics/README.md) — the stdio provider that registers against this seam.
- [dsh-tool-lsp-diagnostics](../tool-lsp-diagnostics/README.md) — the model-facing tool over this seam.
- [lsp group map](../README.md) — the six-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-lsp-diagnostics`, which owns the model-facing `lsp-diagnostics` schema, prompt guidance, and rendered results while this registry contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-lsp-diagnostics` owns request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the seam's current scope. They are package constraints, not a task backlog.

- **Single global provider (v1)** — only one diagnostics provider may be registered per harness; selection is not per-workspace or per-extension, so a second provider conflicts even with a different id. Per-workspace routing is the intended extension.
- **No per-extension map** — unlike `ctx.lsp`, diagnostics selection is workspace-scoped; extension-to-language mapping lives in the stdio provider to drive `didOpen`/`didChange` language ids, not in the seam.
- **Caps are provider-enforced** — the seam does not enforce `MAX_PER_FILE=20` or cross-file 5; providers do, and consumers must treat snapshots as already capped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
