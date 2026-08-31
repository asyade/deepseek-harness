---
description: "The stdio diagnostics provider for ctx.lspDiagnostics: persistent document sync, push (publishDiagnostics) + pull (textDocument/diagnostic + workspace/diagnostic) hybrid, debounced merge/dedupe/caps, for users and maintainers composing local diagnostics."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-stdio-diagnostics

English | [中文](README.zh.md)

## Summary

`dsh-lsp-stdio-diagnostics` turns configured local language-server commands into providers on `ctx.lspDiagnostics`: give it a table of server commands and extension-to-language mappings, and agents get workspace-scoped diagnostics — errors, warnings, and hints — served by real language servers. One plugin instance registers one isolated diagnostics provider per configured server; each provider lazily starts one server process per workspace and keeps documents open (`didOpen`/`didChange`) for the lifetime of that workspace, serving a push+pull hybrid (publishDiagnostics plus `textDocument/diagnostic` and `workspace/diagnostic`) with debounced merge, dedupe, and caps. Servers and sources always live in the mounted filesystem and subprocess execution world. It is a generic host, not a language-server catalog or installer — deployments configure commands explicitly. This package trusts its configured servers and adds no sandbox of its own.

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

Mount this provider when a deployment has local language servers — for example `typescript-language-server` — and wants the harness to surface diagnostics through them. It needs filesystem and subprocess providers for the same execution world, plus the `dsh-lsp-diagnostics` seam and, for model access, `dsh-tool-lsp-diagnostics`.

### Minimal configuration

The `servers` record maps each stable provider id to one server command. The provider resolves every executable at load after credential scrubbing, so a bad entry prevents every provider from registering; processes launch lazily on the first workspace diagnostics query.

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

| Field | Default | Meaning |
|---|---|---|
| `command` | required | Executable to spawn — absolute, or resolved on the child PATH at load; launched without a shell |
| `extensionToLanguage` | required | Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`) |
| `args` | `[]` | Arguments passed to the executable |
| `env` | `{}` | Extra env merged over the credential-scrubbed ambient env; variables matching `KEY`/`PASSWORD`/`SECRET`/`TOKEN` and all `DSH_*` names are not forwarded |
| `initializationOptions` | `null` | Static `initialize` options forwarded to the server |
| `configuration` | `null` | Static answer to every `workspace/configuration` item |
| `maxMessageBytes` | `16000000` | Largest single framed message accepted from the server |
| `maxStderrBytes` | `1000000` | Largest stderr tail retained for diagnostics |
| `maxDocumentBytes` | `4000000` | Largest source document accepted for sync |
| `shutdownTimeoutMs` | `5000` | Graceful `shutdown`/`exit` budget before escalation |
| `killGraceMs` | `2000` | Request-cancel and SIGTERM→SIGKILL escalation grace |

`servers` must contain at least one entry with non-empty ids; timer budgets must be positive integers within Node's timer range, and byte caps must be positive. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsp-stdio-diagnostics) is the exhaustive source for every accepted field.

### Clippy deployment examples

<a id="clippy-deployment-examples"></a>

Clippy lints ride the same `ctx.lspDiagnostics` push-feed — no new seam. Both examples produce `LspDiagnostic{severity 1|2, code, message, range}` with the provider's debounced merge (`150 ms`), dedupe (`JSON.stringify({ code, severity, message, source, range })`), and caps (`20` per file, `5` files). See [GOAT research](../../../docs/research/2026-08-31-goat-lint-diagnostics.md#24-extended-cargo-clippy-diagnostic--is-it-relevant) and [LSP subsystem](../../../docs/subsystems/lsp.md#clippy-via-lsp--deployment-example).

**rust-analyzer clippy (recommended for small workspaces):** configure `rust-analyzer` to run `cargo clippy` on save. Pin `msrv` in `clippy.toml` (or `[lints.clippy]` in `Cargo.toml`) and whitelist pedantic lints — never enable `pedantic`/`nursery`/`restriction` wholesale in CI.

```yaml
- name: '@deepseek-ai/dsh-lsp-stdio-diagnostics'
  config:
    servers:
      rust-analyzer-clippy:
        command: rust-analyzer
        initializationOptions:
          check: { command: clippy, extraArgs: ['--', '-W', 'clippy::pedantic'] }
        extensionToLanguage: { '.rs': rust }
```

```toml
# clippy.toml — keeps editor and CI in sync
msrv = "1.78"
```

CI gate (conditional): `cargo clippy --all-targets --all-features -- -D warnings`.

**bacon-ls cargo backend (GOAT for large workspaces):** `bacon` + `bacon-ls` runs `cargo clippy --message-format=json-diagnostic-rendered-ansi` per save/open/close and streams `publishDiagnostics` every `refreshIntervalSeconds:5`. Requires disabling `rust-analyzer` diagnostics to avoid double publish:

```yaml
- name: '@deepseek-ai/dsh-lsp-stdio-diagnostics'
  config:
    servers:
      bacon-ls:
        command: bacon-ls
        extensionToLanguage: { '.rs': rust }
        initializationOptions: { updateOnSave: true, updateOnChange: true, refreshIntervalSeconds: 5 }
```

Pick one per `workspaceRoot` — `rust-analyzer` and `bacon-ls` compete for `publishDiagnostics`.

### What a query does

On the first pull for a workspace, the provider launches one server process for that workspace and keeps it pooled. Documents are opened persistently (`didOpen` once, then `didChange` on edits) for the lifetime of the workspace, so the server can push `publishDiagnostics` and answer `textDocument/diagnostic` and `workspace/diagnostic` without transient open/close per query. Push snapshots are debounced, merged, deduped (`JSON.stringify({ code, severity, message, source, range })` per `client.ts:91-105`), and capped (20 per file, 5 files) before delivery; the pull path returns the same merged snapshot. Queries to one server and workspace are serialized; different workspaces run in parallel. If the pooled process fails during a pull, the provider retries once on a fresh process.

### Observable success and failures

A successful snapshot carries `byFile` (file → diagnostics), `workspaceRoot`, and `at` timestamp; an empty map means no diagnostics. The pull fails when the source is missing, non-regular, non-UTF-8, oversized, or outside the canonical workspace (rejected before the server starts), or when the server returns a malformed payload. A hard-killed harness leaves servers running until they exit on their own — graceful shutdown happens only through service disposal.

### Security boundary

This provider trusts its configured server and adds no sandbox confinement; the server receives the filesystem and process authority of the mounted execution world. It rejects query sources that are missing, non-regular, non-UTF-8, oversized, or canonically outside the workspace before server startup. Mount filesystem and subprocess providers for the same execution world — a split-world composition is invalid.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and where the code realizes them; observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Generic host, not a catalog.** Deployments configure commands and mappings explicitly; presets belong in `cordis.yml` overlays, not in this package.
- **Persistent sync, not transient open.** Each workspace instance keeps documents open (`didOpen`/`didChange`) so pushes and pulls share state; no per-query open/close cycle.
- **Hybrid push+pull.** The instance merges `publishDiagnostics` pushes with `textDocument/diagnostic` and `workspace/diagnostic` pulls, then dedups and caps once — consumers see one debounced snapshot regardless of which path produced it.
- **One pooled process per canonical workspace.** Instances are single-flighted per `(server id, canonical workspace target)`; a transport failure retries the pull once on a fresh process after awaiting disposal.
- **Per-workspace serialization.** One abortable queue per workspace serializes source-read/sync/query lifecycles; distinct workspaces run in parallel, and a cancellation that fails to stop a server terminates only that instance.
- **Bounded teardown.** Graceful `shutdown`/`exit` escalates through tree termination (process-group signaling on POSIX, `taskkill /T /F` on Windows); quiescence is confirmed by awaiting process-tree exit, not by the kill outcome.
- **Execution-world pairing.** Servers launch through `ctx.subprocess` with `processId: null`, sources read through `ctx.fs`, and no `fs/observed` event is emitted — only the diagnostics snapshot is model-visible.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, executable resolution, diagnostics provider registration, workspace pooling |
| [`src/host.ts`](src/host.ts) | Workspace canonicalization and bounded source reads through `ctx.fs` |
| [`src/instance.ts`](src/instance.ts) | One server process: initialize, persistent document sync, hybrid pull/push, merge/dedupe/caps |
| [`src/connection.ts`](src/connection.ts) | JSON-RPC endpoint: id correlation, outbound requests, inbound server requests, stderr cap |
| [`src/framing.ts`](src/framing.ts) | `Content-Length` framing and a bounded decoder |
| [`src/protocol.ts`](src/protocol.ts) | Wire-type subset: diagnostics, capabilities, raft for publish/pull |
| [`src/translate.ts`](src/translate.ts) | Position-encoding negotiation, diagnostic normalization, `dedupeDiagnostics`/`capSnapshotFiles` |
| [`src/abort.ts`](src/abort.ts) | Cancellation helpers fusing caller and disposal signals |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; pools and queues are private state) |

### Protocol behavior

Initialization advertises UTF-16 positions, workspace folders and configuration, and diagnostics capabilities (pull and workspace); the server's returned capabilities are authoritative. An omitted server `positionEncoding` defaults to `utf-16`. The client answers `workspace/configuration` from static config, accepts lifecycle bookkeeping requests, and merges `publishDiagnostics` pushes with `textDocument/diagnostic` and `workspace/diagnostic` pulls before `JSON.stringify({ code, severity, message, source, range })` dedup and `MAX_PER_FILE=20` / `MAX_FILES_PER_SNAPSHOT=5` capping.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared diagnostics model to the seam, the tool, and the decision evidence.

- [LSP navigation subsystem](../../../docs/subsystems/lsp.md) — diagnostics seam, snapshot, push observation, and `LspError` codes.
- [dsh-lsp-diagnostics](../lsp-diagnostics/README.md) — the seam this provider registers against.
- [dsh-tool-lsp-diagnostics](../tool-lsp-diagnostics/README.md) — the model-facing tool over the seam.
- [lsp group map](../README.md) — the six-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-lsp-diagnostics`, which surfaces this provider's merged snapshots while this host contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-lsp-diagnostics` owns request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No confinement policy** — this package trusts the configured server and does not sandbox its process; a restricted deployment must supply appropriate process and filesystem providers or a same-world sandbox wrapper.
- **Persistent-sync memory cost** — documents stay open per workspace until disposal; long-lived workspace processes consume memory until the harness disposes the provider.
- **Per-workspace serialization latency** — parallel agents sharing one server and workspace queue behind one process; distinct workspaces run in parallel.
- **A hard-killed harness orphans language servers** — `initialize.processId: null` removes server-side client-PID monitoring, so servers are cleaned only by graceful service disposal; a SIGKILL'd harness leaves them running until they exit on their own.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
