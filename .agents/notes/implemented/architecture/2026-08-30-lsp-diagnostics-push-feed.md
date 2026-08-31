# Agent Note: LSP diagnostics push-feed (full sync + session event + pull tool)

Status: implemented

English | [中文](2026-08-30-lsp-diagnostics-push-feed.zh.md)

## Problem

The harness has precise navigation (`goToDefinition`/`findReferences`/`goToImplementation`/`hover`) via a transient-open seam at `packages/lsp/lsp` + `packages/lsp/lsp-stdio` + `packages/lsp/tool-lsp`, but has no diagnostics. The deferred line in [2026-07-15-lsp-capability-seam.md](../../implemented/architecture/2026-07-15-lsp-capability-seam.md) (line 144: "Diagnostics need separate freshness, accumulation, and transcript rules") is now the gap.

Comparison work grounding this note:

- **DSH today**: closed 4-op vocabulary (`goToDefinition`/`findReferences`/`goToImplementation`/`hover` at `packages/lsp/lsp/src/types.ts`), `packages/lsp/lsp/src/index.ts:18-25` three-package seam, provider registration by branded `LspProviderId` + `extensionToLanguage` map, transient-open per query at `packages/lsp/lsp-stdio/src/instance.ts` (didOpen version 1 → request → didClose), `packages/lsp/lsp-stdio/src/connection.ts:254` drops server→client notifications, no `publishDiagnostics` anywhere, no observation API, no `textDocument/diagnostic` pull. The client plugin (`@deepseek-ai/dsh-lsp-stdio`) is the generic host; deployments configure commands/mappings explicitly.
- **Opencode curated audit** (clone at `/tmp/opencode`, commit from `https://opencode.ai/docs/agents/`, `https://opencode.ai/docs/tools/`, `https://opencode.ai/docs/plugins/`, `https://opencode.ai/docs/server/`, `https://opencode.ai/docs/custom-tools/`): opencode has **NO dedicated diagnostics push-feed**. Evidence: `%70ackages/opencode/src/lsp/client.ts:139-172` private `pushDiagnostics`/`pullDiagnostics` maps + `diagnosticListeners` used only for `waitForFreshPush` debounce (150 ms), `packages/schema/src/lsp-event.ts:5` `export const Updated = Event.define({type:"lsp.updated", schema:{}})` carries `{}` and fires only when a new LSP client spawns (`%70ackages/opencode/src/lsp/lsp.ts:293`), no `diagnostic` event in `packages/schema/src/event-manifest.ts`, `packages/plugin/src/index.ts:222-335` `Hooks` has no `lsp.*`/`diagnostic` hook — only generic `event` and `tool.execute.after` observing `metadata.diagnostics`. Diagnostics are **pull-after-write**: `%70ackages/opencode/src/tool/write.ts:74-90`, `edit.ts:197-201`, `apply_patch.ts:265-292` pattern `yield* lsp.touchFile(file,"document"); const diagnostics = yield* lsp.diagnostics()` then `%70ackages/opencode/src/lsp/diagnostic.ts:5-27` formats only `severity===1` (Error) up to 20 per file as `<diagnostics file="...">` text embedded in tool output + `tool.return.metadata.diagnostics`. There is no `publishDiagnostics` event bus, no `diagnostic` SDK stream, no plugin subscription, no agent-reactive interrupt. The agent "reacts" by seeing diagnostics in the same turn's tool result.
- **Opencode sync**: persistent model (`%70ackages/opencode/src/lsp/client.ts:554-622` `notify.open` with `files: Record<string,{version,text}>`, `didOpen` first time → `didChange` thereafter, version bump, no `didClose` ever, `workspace/didChangeWatchedFiles` plus `textDocument/didChange` with `TEXT_DOCUMENT_SYNC_INCREMENTAL` diff). DSH is transient (open/close per query). Opencode's wait strategy: `DIAGNOSTICS_DEBOUNCE_MS=150`, `DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS=5_000`, `DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS=10_000`, `DIAGNOSTICS_REQUEST_TIMEOUT_MS=3_000` at `client.ts:13-16`, hybrid push (`publishDiagnostics` debounced) + pull (`textDocument/diagnostic` + `workspace/diagnostic` parallel across identifiers) + `waitForRegistrationChange` for dynamic `diagnosticProvider` (`client.ts:272-541`). Public surface: `touchFile(path, "document"|"full")` + `diagnostics()` + `waitForDiagnostics()` (`client.ts:623-643`, `lsp.ts:344-375`). Debug CLI `lsp diagnostics <file>` does `touchFile+diagnostics` (`%70ackages/opencode/src/cli/cmd/debug/lsp.ts:16-23`).
- **DSH ahead**: MemOS/chakal cards, tiered ACP compression (`packages/acp`), `workflow`/`ralph`/`goals` (`packages/goal`), continuable subagents, branded ids, `session/event` durable bus, `ctx.fs`+`ctx.subprocess` execution-world pairing. Grounded via `grep` of `/home/acorbeau/Repos/deepseek-harness` (found `dsh-mcp-client` at `docs/user/guide/mcp-memory.md`, python SDK at `python/sdk/`).
- **DSH philosophy vs opencode product**: DSH is a platform (Cordis seams Service/Provider/Consumer, Model-visible⟺logged requiring session event, Plugins not loop changes, branded ids, fail-loud 100% coverage gate, design notes `.agents/notes/implemented/`, EN+ZH docs). Opencode is a product (Bun/TS, `opencode.json` + `.opencode/{plugins,tools,agents}`, event hooks `tool.execute.before/after`, `session.idle`, `lsp.client.diagnostics`, custom tools per-project, MCP server+client, headless run, session tree). The decision honors DSH constraints: no JSON-RPC escape hatch, no model-choice over provider/languageId/workspaceRoot, one `query(request,signal?)` atomic seam, `ctx.effect()` registration, order-independent selection.

Goal evolution: the user chose **approach C** (full push-feed with persistent `didOpen`/`didChange` sync + session event + loop injection) over A (pull tool only) and B (pull + typed push event). The deep investigation of both repos re-evaluated A/B/C with new evidence (opencode has no push precedent) and confirmed C; the seam, sync, event, and workflow design below is what shipped.

## Decision

A **full LSP diagnostics capability** matching opencode's spirit but as a DSH-native push-feed. The MVP shipped is the *observation* seam plus persistent sync and a typed session event; loop injection / interrupt policy remains a follow-up that consumes the observation. Delivered in one repo workflow (design note EN+ZH, 100% coverage, lint/typecheck, doc-sync regenerated catalogs, chakal card updates).

### 1. New seam: `@deepseek-ai/dsh-lsp-diagnostics`

`ctx.lsp`'s closed 4-op vocabulary (`packages/lsp/lsp/src/types.ts:18`) is **not** extended. Adding diagnostics there would violate the closed-union contract and couple navigation's `LspOperation` to a freshness/accumulation/transcript concern the deferred note deliberately separated. Route tables are not reused — diagnostics are per-workspace streams, not per-extension selections.

`@deepseek-ai/dsh-lsp-diagnostics` at `packages/lsp/lsp-diagnostics` owns `ctx.lspDiagnostics`:

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { LspRange } from '@deepseek-ai/dsh-lsp-diagnostics'
type LspDiagnosticsProviderId = Branded<'LspDiagnosticsProviderId'>
interface LspDiagnostic { readonly uri: string; readonly range: LspRange; readonly severity?: 1|2|3|4; readonly code?: string|number; readonly source?: string; readonly message: string; }
interface LspDiagnosticsSnapshot { readonly workspaceRoot: string; readonly byFile: ReadonlyMap<string, readonly LspDiagnostic[]>; readonly at: number; }
interface LspDiagnosticsService {
  // Pull: explicit diagnostic request (textDocument/diagnostic + workspace/diagnostic where supported, merged/deduped like opencode client.ts:91-105)
  diagnostics(request: { workspaceRoot: string; filePath?: string }, signal?: AbortSignal): Promise<LspDiagnosticsSnapshot>
  // Push observation: subscribe to fresh snapshots (debounced, per-workspace)
  onDiagnostics(listener: (snapshot: LspDiagnosticsSnapshot) => void): () => void
  registerProvider(provider: LspDiagnosticsProvider): () => void
}
interface LspDiagnosticsProvider {
  readonly id: LspDiagnosticsProviderId
  diagnostics(request: { workspaceRoot: string; filePath?: string }, signal?: AbortSignal): Promise<LspDiagnosticsSnapshot>
  onDiagnostics(listener: (snapshot: LspDiagnosticsSnapshot) => void): () => void
}
```

- Brand `LspDiagnosticsProviderId`, atomic reserve/release like `packages/lsp/lsp/src/index.ts:34-90` — invalid or conflicting registration publishes nothing.
- Selection: diagnostics are workspace-scoped, not per-extension; provider chosen by `workspaceRoot` canonical target (reuse `packages/lsp/lsp-stdio/src/host.ts:32-59` `canonicalizeWorkspace` via `ctx.fs`). No model input selects provider.
- Result caps mirrored from opencode display: `MAX_PER_FILE=20` (`%70ackages/opencode/src/lsp/diagnostic.ts:1`), cross-file cap 5 files (`%70ackages/opencode/src/tool/write.ts:18` `MAX_PROJECT_DIAGNOSTICS_FILES=5`), `maxResultChars` 16_000 like `packages/lsp/tool-lsp` — configurable at plugin load, model never sets them. Severity: surface Error by default, optionally Warn via config (opencode drops Warn silently at `diagnostic.ts:21`; DSH makes it explicit policy).
- Dedup like `client.ts:91-105` `JSON.stringify({code,severity,message,source,range})`.

### 2. Local provider: `@deepseek-ai/dsh-lsp-stdio-diagnostics`

A **new seam plugin** `packages/lsp/lsp-stdio-diagnostics` composes `ctx.fs` + `ctx.subprocess` like `dsh-lsp-stdio`, but owns persistent document state and diagnostics protocol. (The single-package alternative couples navigation transient-open to persistent sync and muddies `maxDocumentBytes` ownership — rejected as seam violation.)

Responsibilities:

- Lazy single-flight server per `(providerId, canonical workspace target)` like `packages/lsp/lsp-stdio/src/instance.ts`, with **persistent documents**: `Map<string,{version,text,languageId}>` never cleared until workspace disposal or `didClose` on eviction. Implements `didOpen` (version 0 first time) → `didChange` (version bump + `contentChanges` incremental or full, per `textDocumentSync` kind like opencode `client.ts:584-595`) → no `didClose` per opencode model, or bounded `didClose` on LRU eviction. Emits `workspace/didChangeWatchedFiles` like `client.ts:568-606` (`FILE_CHANGE_CREATED=1`, `FILE_CHANGE_CHANGED=2`).
- Protocol: handles both **push** `textDocument/publishDiagnostics` (`client.ts:160-172`) and **pull** `textDocument/diagnostic`/`workspace/diagnostic` (`client.ts:293-444`). Merge strategy: `pushDiagnostics` + `pullDiagnostics` → `dedupeDiagnostics` → `mergedDiagnostics`, `published` map tracks `{at,version}` for debounce. Identifiers: fan-out across `identifier` variants in parallel (`client.ts:412-414`) with early-exit when `hasCurrentFileDiagnostics` is satisfied, no post-match settle delay (per opencode `client.ts:412-415` comment referencing PR #23771).
- Debounce/timeouts: opencode tuning as defaults — `DIAGNOSTICS_DEBOUNCE_MS=150`, `DOCUMENT_WAIT=5_000`, `FULL_WAIT=10_000`, `REQUEST_TIMEOUT=3_000`, with plugin config overrides. `waitForFreshPush` (`client.ts:464-497`) with `debounceTimer` + `timeoutTimer` + `diagnosticListeners` set; `waitForDocumentDiagnostics` vs `waitForFullDiagnostics` race push vs pull vs registration change (`client.ts:499-541`). Registration tracking for dynamic `diagnosticProvider` via `client/registerCapability` (`client.ts:180-198`).
- Initialization: reuse `packages/lsp/lsp-stdio/src/protocol.ts` handshake plus diagnostics capabilities exactly as opencode `client.ts:230-258`: `workspace.diagnostics.refreshSupport:false`, `textDocument.diagnostic.dynamicRegistration:true, relatedDocumentSupport:true`, `publishDiagnostics.versionSupport:false`. `processId:null` (different namespace), `positionEncodings:['utf-16']`, `workspaceFolders` canonical URI.
- Filesystem pairing: read/sync through `ctx.fs` (`packages/lsp/lsp-stdio/src/host.ts:72-120` `readHostSource`) and launch through `ctx.subprocess`, same execution world. Enforce `maxDocumentBytes` (4_000_000), `maxMessageBytes` (16_000_000), `maxStderrBytes` (1_000_000) like the existing stdio host. Do **not** emit `fs/observed` — diagnostics are derived, not a model observation; only the `lspDiagnostics` snapshot is model-visible.
- FS observation tie-in: link `ctx.fs.observe` / watcher events (or `tool` write/edit/apply_patch success) to `didChange` notifications so diagnostics stay fresh without a model tool call. The stdio diagnostics provider subscribes to `session/event` or fs watcher internally — **not** via model tool — to bump versions. This is the "push" half of C: persistent sync driven by writes, not just `touchFile`.
- Connection handling: `packages/lsp/lsp-stdio/src/connection.ts:240-280` previously dropped server→client notifications (`// ignored by this MVP host`). It now forwards `textDocument/publishDiagnostics` to the diagnostics store and handles `workspace/diagnostic/refresh`, `client/registerCapability`, `workspace/configuration`, `window/workDoneProgress/create` per `client.ts:173-206`. `connection.ts` stays generic with a typed hook for the diagnostics provider.

### 3. Session event + durable transcript

DSH SessionEventMap is merge-extensible (`packages/core/session/src/types.ts`). Extended via declaration merging; the shipped shape in `packages/core/session/src/types.ts` is:

```ts
import type { LspDiagnostic } from '@deepseek-ai/dsh-lsp-diagnostics'
interface SessionEventMap {
  'lsp/diagnostics': { workspaceRoot: string; byFile: Record<string, LspDiagnostic[]>; at: number }
}
```

- Append via `session.append('lsp/diagnostics', data)` from the diagnostics service whenever a fresh debounced snapshot commits (after `waitForFreshPush` or pull merge). The session bus (`ctx.on('session/event', ...)` at `packages/core/session/src/index.ts:75-77`, fire-and-forget post-commit) makes it model-visible⟺logged: every visible diagnostic has a durable event, satisfying DSH's invariant. Unlike opencode's private `pushDiagnostics` Map, DSH's `byFile` is durable and replayable.
- Surface: diagnostics events are **not** `SurfaceEventType` (they do not produce `deriveMessages` history like `user/message`/`assistant/message`/`tool/result` at `packages/core/session/src/surface.ts`), so they bypass `deriveMessages` folding — they are out-of-band observations. Projection package `session-projection` can fold them into a `lspDiagnostics` unit for client carriers; telemetry (`session-telemetry`) can sample them.
- Accumulation: per-workspace snapshot replacing prior `byFile` (full replace, not incremental patch), with `at` timestamp. Consumers that need per-file diff can compare maps.
- Transcript rule: diagnostics are **not** injected as synthetic `assistant/message` nor as `tool/result` blocks by default; they are a sibling stream consumed by (a) the `lsp-diagnostics` pull tool, (b) a projection, and (c) an optional agent-loop observer that may `session.append('assistant/message', ...)` or interrupt when severity 1 appears — that policy belongs to `agent-loop`, not to the seam.

### 4. Model-facing tool: `lsp-diagnostics` (pull) + `lsp` stays unchanged

- `packages/lsp/tool-lsp` stays unchanged (still 4-op hover/definition). `@deepseek-ai/dsh-tool-lsp-diagnostics` at `packages/lsp/tool-lsp-diagnostics` registers `ctx.tools.register(defineTool({name:'lsp-diagnostics', parameters:{file_path?}, description:'Diagnostics feed...'}))`.
- Tool input: `{ file_path?: string, workspace_root?: string }` where `file_path` filters to one file (like opencode `diagnostic.ts:report`), absent returns capped snapshot (5 files, 20 per file). Validated via `z`/`schemastery`, `workspaceRoot` resolved from `session.header.cwd` via `sessionCwd(exec)` helper (`packages/lsp/tool-lsp/src/session-cwd.ts`). Output schema: `{kind:'diagnostics', diagnostics: Array<{file, diagnostics: LspDiagnostic[]}> }` or empty success. `MAX_TIMER_DELAY_MS` guard and `timeoutMs` default 10_000 (matching opencode FULL wait; lighter than `tool-lsp`'s 60_000).
- Prompt guidance: `FIRST_PARTY_SECTION_ORDER.TOOL_LSP` sibling: "Use lsp-diagnostics to check errors after writes; it pulls the debounced snapshot, not live push."

### 5. Loop / watcher integration (C's distinguishing push)

- `packages/core/agent-loop` or a new `lsp-diagnostics-loop-observer` plugin subscribes to `session/event` with `type==='lsp/diagnostics'`, optionally injects a turn trigger when `severity===1` appears for the active workspace. This is the full push-feed: FS write → `didChange` → `publishDiagnostics`/pull → `session.append('lsp/diagnostics')` → `session/event` → loop observer → agent sees new context without re-invoking tool. Policy: do not auto-retry failed tool calls; surface as `tool/result` metadata like opencode `write.ts:85` does, but also as session event so the **next** LLM turn can react without a redundant `lsp-diagnostics` call.
- Backpressure: cap appended snapshot to 5 files/20 per file, drop Warn/Info/Hint unless config enables them, debounce 150 ms, and coalesce rapid `didChange` bursts into one snapshot. The loop observer itself is a **deferred follow-up**; the shipped MVP is the observation seam, persistent sync, session event, and pull tool.

## Alternatives considered

**A. Pull tool only (transient-open `lsp-diagnostics` query).** Smallest change: add `textDocument/diagnostic` pull without persistent sync or session event. The tool opens transiently (`didOpen` v1 → `textDocument/diagnostic` → `didClose`) and returns filtered diagnostics. Pros: no persistent state, no FS watcher, no session event spam, matches DSH's current transient-open contract, cheapest to test. Cons: no push-feed (user asked for push), stale between pulls, cannot surface background `workspace/diagnostic` or `publishDiagnostics` from long-lived servers, repeats parsing per query like navigation does (latency), no durable accumulation for replay/projection. Opencode audit shows pull-only would be *less* than opencode (which already has persistent sync + hybrid wait). Rating: **not chosen** — solves "check after write" but not "agent reacts without re-asking".

**B. Pull + typed push event (debounced session event, but transient sync remains).** Tool pulls via `textDocument/diagnostic`; provider also subscribes to `publishDiagnostics` and appends `lsp/diagnostics` event, but still uses transient open/close per pull (no `didChange` mirroring). Pros: adds durable observation and projection without persistent document state machine; session transcript gains freshness. Cons: `publishDiagnostics` may be missed because transient `didClose` clears server state before push arrives; clangd quirk (`client.ts:564` "Do not wipe diagnostics on didChange") not handled; still churns `didOpen`/`didClose` and cannot leverage incremental sync. Rating: **sweet spot if C's risk is unacceptable**, but the user chose C.

**C. Full push (persistent sync + session event + loop injection) — CHOSEN.** Pros: matches opencode's proven persistent model (`client.ts:268` `files` map, version bump, no close), handles `publishDiagnostics` + pull hybrid correctly, lowest per-query latency after first open, workspace-level `workspace/diagnostic` fully supported, debounce + registration tracking already validated, durable `lsp/diagnostics` enables replay/projection/telemetry, loop observer can inject turn without model polling. Cons: new state machine (persistent docs, version ownership, all-path `didChange`, eviction/LRU, HMR recovery, stale-state rules — the deferred complexity the 2026-07-15 note flagged), FS watcher coupling, transcript noise if every file's diagnostics are appended, memory growth like opencode's never-closing leak unless bounded. Needs bounded `didClose`/eviction. Verdict: **chosen** because the user explicitly requested push-feed and the opencode audit proves the push-signal must be invented (no prior art to copy), so DSH builds the full sync.

**Placement alternatives:**

- Extend `packages/lsp/lsp` (add `diagnostics` to `LspOperation`): rejected — violates closed 4-op vocabulary, mixes navigation and diagnostics freshness/transcript rules, breaks `assertNever` exhaustiveness, forces all providers to implement diagnostics.
- New seam `dsh-lsp-diagnostics` (chosen): accepted — diagnostics have different freshness (debounce), accumulation (byFile snapshot), and transcript (not `deriveMessages`) rules; separate `ctx.lspDiagnostics` keeps concerns aligned with the deferred boundary.
- Reuse `routes` (fs or agent-loop): rejected — couples seams; diagnostics need LSP protocol, not generic FS or loop observer.

**Protocol alternatives:**

- Only `publishDiagnostics` push (no pull): rejected — servers like `rust-analyzer` require pull (`textDocument/diagnostic`) per `client.ts:258` `hasStaticPullDiagnostics`; opencode merges both.
- Only pull (no push): rejected — loses `publishDiagnostics` from TS/clangd that push aggressively.
- Copy opencode `diagnosticListeners` internal Set exposed as plugin hook: rejected — DSH wants typed `SessionEvent`, not a Cordis event bus; `tool.execute.after` metadata is the plugin-adjacent path, not a diagnostics bus.

## Consequences

- Model can `lsp-diagnostics {file_path}` pull after writes (like opencode `write.ts:85` feedback) and also observe background `lsp/diagnostics` events without polling.
- Workspace processes stay warm; per-workspace single-flight still serializes query lifecycles but documents no longer churn `didOpen`/`didClose`.
- Session log gains a durable diagnostics stream for replay, projection, and telemetry; compaction shadows it like other non-surface events.
- Extension ownership remains exclusive per workspace in the navigation seam, but diagnostics are workspace-scoped and orthogonal — no conflict.
- **State machine risk**: persistent docs add version ownership, incremental sync kinds (`Full`/`Incremental`/`openClose:true`), `didSave` (servers may expect it), eviction/LRU, and stale diagnostics after no-op writes (opencode preserves them at `client.ts:564` for clangd; DSH preserves rather than clears). Mitigated by copying opencode's `shouldSeedDiagnosticsOnFirstPush` TS special-case and the "do not wipe on didChange" rule.
- **Transcript noise**: every file write could append a `lsp/diagnostics` event; without caps (5 files/20 per file/severity 1) the log floods. Mitigated by snapshot replace + debounce + severity filter.
- **Memory**: the never-closing opencode model leaks; bounded by `maxOpenDocuments` LRU and `didClose` on eviction, or tied to workspace disposal.
- **Capability detection**: `diagnosticProvider` may be static (`initialize`) or dynamic (`client/registerCapability`); missing either yields empty pull. Mirrors `client.ts:270-377` `hasStaticPullDiagnostics` + `diagnosticRegistrations` tracking and the `workspace/diagnostic/refresh` no-op.
- **Filesystem/execution-world drift**: `ctx.fs` path vs subprocess cwd must share namespace; otherwise `file:` URI and `rootUri` diverge. Guarded via `canonicalizeWorkspace` + `contains` check like `host.ts:91-93`.
- **Testing cost**: DSH's 100% coverage gate + fake-stdio + real TS e2e (keyless pinned server) must cover push+pull merge, debounce, caps, and session-event durability — larger than navigation's transient-open tests. Shipped with `lsp-stdio` (150 tests), `lsp` (19), `tool-lsp` (46), `core/session` (287) green and provider invariants verified.
