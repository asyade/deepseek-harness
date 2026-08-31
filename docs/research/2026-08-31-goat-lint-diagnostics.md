# GOAT Lint & Diagnostics — Deep Research (cargo / npm / generic files / clippy)

English | [中文](2026-08-31-goat-lint-diagnostics.zh.md)

**AS OF:** 2026-08-31

**Audience:** DSH maintainers — to decide what lint/diagnostic surfaces to add next, after the LSP diagnostics push-feed (`packages/lsp/lsp-diagnostics` + `lsp-stdio-diagnostics` + `tool-lsp-diagnostics`).

**Question asked verbatim:** *"Lint for cargo.toml (deprecated/old deps) same for package.json + vulnerables (optional), More lint for other languages/files (json,yaml etc), Do we have extended cargo clippy diagnostic? is it relevant to add → Do online search for various similar prior art/work i'm sure there is tones and find the goat/top patterns to replicate."*

**Stakes:** Medium — correctness + supply-chain hygiene; wrong choice = wasted CI minutes or noisy diagnostics.

> **Direct answer up front:** Yes — all three expansions are worth doing, but in different lanes:
> 1. **Clippy extended diagnostics = immediate win via existing LSP seam** — just configure `rust-analyzer.check.command="clippy"` (or `bacon-ls` cargo backend for large workspaces); no new DSH code except docs/config. GOAT: `rust-analyzer` + `clippy` + opt `bacon-ls`. [1][2][3]
> 2. **Cargo.toml / package.json deprecated & vuln lint = separate "dependency health" lane** — not LSP; use `cargo-deny` (super-set) + `cargo shear/machete/udeps` for Cargo, and `knip` + `osv-scanner` (or `npm audit`) for JS/TS. GOAT: `cargo-deny` + `cargo-shear` + `knip` + `osv-scanner`. [4][5][6][7][8]
> 3. **Generic file lint (json/yaml/toml) = formatter + schema lane** — `taplo` for TOML, `yamllint` + `spectral` for YAML/JSON, `biome`/`oxlint`/`dprint` already cover JS/TS in this repo. GOAT: `taplo` + `yamllint` + `spectral` + `biome`/`dprint`. [9][10][11][12][13]
> 4. **Orchestration GOAT = trunk vs megalinter vs lefthook/pre-commit** — for monorepos, `trunk check` is the hermetic universal checker that normalizes all linters; `megalinter` is the Docker-batteries-included alternative; `lefthook` (already adopted here) is the hook runner. DSH already uses `lefthook` + `oxlint` + `knip`; adding `trunk` would subsume them but is heavy migration. [14][15][16]

Confidence: **High** for clippy & cargo-deny/knip/taplo (well-documented, many citations); **Medium** for orchestration ranking (trunk popularity rising but lefthook is entrenched in this repo).

---

## 1. Methodology

5 parallel research threads (workflow `goat-diagnostics-research`) — each ran 2–4 `web_search` queries, fetched 2–3 best sources, distilled to facts/analysis/gaps. Sources deduped into registry §6. No browser automation needed; `web_fetch` succeeded for key pages. All claims below cite registry numbers.

Threads:
- `cargo-deny/audit/vet/supply-chain`
- `cargo-clippy/bacon-ls/rust-analyzer`
- `package.json-knip-depcheck`
- `taplo-toml-yaml-json` (generic file lints)
- `trunk-megalinter-orchestration`

Local workspace inspected: `lefthook.yml` (staged oxlint + whitespace + third-party notices, pre-push typecheck), `knip.json` (already configured, `treatConfigHintsAsErrors`), `.oxlintrc.json` (type-aware), no `deny.toml`/`cargo-deny` yet, no `taplo.toml`/`yamllint`. Root is pnpm workspace — Rust `Cargo.toml` not present at repo root (native/landlock-run may have one), but threat model still applies.

---

## 2. Detailed Findings

### 2.1 Cargo.toml lint — deprecated / outdated / unused / vulnerable

| Goal | GOAT tool | Why GOAT | Config | CI | Output → diagnostics |
|------|-----------|----------|--------|----|---------------------|
| **Vuln + bans + licenses + sources** (super-set) | **EmbarkStudios/cargo-deny** (~1.2k★, `bevy`/`tokio` use) | One `deny.toml` with 4 checks: `[advisories]` (RustSec DB), `[bans]` (deny/skip duplicates, wildcards), `[licenses]` (allowlist + exceptions), `[sources]` (registry/git). Replaces cargo-audit for advisories *plus* adds policy. [4] | `deny.toml` — see §2.1.1 | `cargo deny check advisories bans licenses sources` or `EmbarkStudios/cargo-deny-action`; cache `~/.cargo/advisory-dbs` | `--format json/sarif` → `level: deny/warn`, `code: bans.duplicate`, `spans` → map `deny→error` |
| **Advisory-only (lightest)** | **rustsec/cargo-audit** (`rustsec/audit-check@v1`) | Single-purpose advisory scanner, zero policy. Good if you don't want deny's 3 extra checks. | none (reads `Cargo.lock` + advisory DB) | `rustsec/audit-check@v1` nightly cron | `--json` → `vulnerabilities[{advisory.id, cvss}]` → error if non-empty |
| **Supply-chain auditing** (manual vetting) | **mozilla/cargo-vet** (~1k★) | Mozilla's shared `audits.toml` federation (`safe-to-run`/`safe-to-deploy`). Complements deny/audit, not replaces. | `supply-chain/config.toml` + `audits.toml` + `imports.lock` | `cargo vet --locked` | `failures` + `suggest` → error until `certify` |
| **Unused deps** (Cargo.toml hygiene) | **cargo-shear** (Boshen, active, 1.13.x) > cargo-machete > cargo-udeps (stagnant) | `cargo-shear` via `syn` parse + `cargo_metadata`, `--fix` rewrites TOML, CI exit 1 on unused. Handles workspace root. Machete regex-only misses; udeps needs full compile + broken on newer cargo. [7] | `Cargo.toml [package.metadata.cargo-shear] ignored = ["crate"]` | `cargo binstall cargo-shear && cargo shear` | Exit 1 + list of unused crates → per-file diagnostic on `Cargo.toml` |
| **Outdated** | **cargo-outdated** / `cargo update --dry-run` + `cargo deny bans multiple-versions = "warn"` | Deny's `multiple-versions` warn catches duplicate semver; `cargo outdated -R` lists stale spec vs latest. Not vuln-aware. | `bans.multiple-versions = "warn"` | cron `cargo outdated` | warn listing |

#### 2.1.1 `deny.toml` shape (Embark spec) [4]

```toml
[advisories]
db-urls = ["https://github.com/RustSec/advisory-db"]
yanked = "warn"; unmaintained = "warn"

[bans]
multiple-versions = "warn"; wildcards = "warn"
deny = ["openssl"]; skip = [{ name = "windows-sys", version = "0.6" }]

[licenses]
allow = ["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception"]
confidence-threshold = 0.8
private = { ignore = true }
[[licenses.exceptions]] name = "adler32" version = "0.1.1" allow = ["Zlib"]

[sources]
unknown-registry = "warn"; unknown-git = "warn"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
```

**DSH fit:** High. Add `deny.toml` at repo root + CI job `cargo deny check`. Even without Cargo at root, `deny` validates `Cargo.lock` presence; for this JS-heavy harness, `knip`/`osv-scanner` matter more, but landing deny now prevents future native/ crate drift.

### 2.2 package.json lint — deprecated / outdated / unused / vulnerable

| Goal | GOAT tool | Why GOAT | Config | CI | Output → diagnostics |
|------|-----------|----------|--------|----|---------------------|
| **Unused deps / exports / files** (JS/TS graph) | **webpro-nl/knip** (8k★, 300k dl/wk, 182 plugins) — **GOAT** | Full import/export graph, not just `package.json` scanning. Finds 7 cats: unused files/exports/types, unused deps/devDeps, unlisted, duplicates, unresolved, binaries. Replaces `depcheck`/`unimported`. Already enabled in this repo (`knip.json`, `package.json: knip --treat-config-hints-as-errors`). | `knip.json` §2.2.1 | `npx knip --reporter json` (or `github-actions`) | `json: {files, issues[{file,line,col,name}]}` → `warning`, `rule: knip/<type>` |
| **Unused deps (light)** | **depcheck** (4.5k★) | Zero-config `require/import` scanner. Faster, but no export/monorepo awareness. | `.depcheckrc: {ignores, ignorePatterns}` | `npx depcheck --json` | `missing:{pkg:[file]}` |
| **Vuln** | **google/osv-scanner** (6k★, SARIF, 30+ lockfiles) vs `npm audit` | `osv-scanner` polyglot, OSV.dev DB, SLSA3; `npm audit` npm-only. Use both: `npm audit` quick, `osv-scanner` CI-grade. | none / `--lockfile` | `osv-scanner --recursive . --format sarif` / `npm audit --json` | SARIF `results[].package+vuln.id` → error |
| **Outdated** | **npm-check-updates (`ncu`)** / `npm outdated` + `renovate`/`dependabot` | Lists semver behind. Not vuln-aware. | `.ncurc.json` | cron `ncu` | warn listing |

#### 2.2.1 `knip.json` shape (already in this repo) [5]

```jsonc
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["src/index.ts", "scripts/**/*.ts"],
  "project": ["src/**/*.{ts,tsx}"],
  "paths": { "@lib/*": ["./lib/*"] },
  "workspaces": { ".": { "entry": ["scripts/*.ts"] }, "packages/*": { "entry": ["src/index.ts"] } },
  "ignore": ["src/legacy/**"], "ignoreDependencies": ["typescript"],
  "treatConfigHintsAsErrors": true
}
```

**DSH fit:** Already adopted — keep. Next: add `osv-scanner` SARIF job alongside `npm audit` (already implied by `pnpm audit`).

### 2.3 Generic file lints — JSON / YAML / TOML / MD

| Filetype | GOAT tool | Why GOAT | Config | CI |
|----------|-----------|----------|--------|----|
| **TOML** (Cargo.toml, taplo.toml) | **tamasfe/taplo** (Rust, 1.6k★, LSP + `taplo://` schema store) | Formatter + linter + LSP (`taplo lsp stdio` → `publishDiagnostics`). Alt: `dprint+toml` wasm. | `taplo.toml: include, [formatting] reorder_keys, [schema]`, `[[rule]]` per-path | `taplo fmt --check --diff` / `taplo check --output=json` [9] |
| **YAML** | **adrienverge/yamllint** (pre-commit staple) + **spectral** for schema | yamllint = pure lint (no format) via `rules: {line-length, indentation}`; spectral = JSON/YAML schema linter (OpenAPI/AsyncAPI + custom JSON Schema, functions `pattern/truthy/schema`). Pair yamllint + prettier/dprint for format. | `.yamllint.yaml: extends: default, rules: {...}`; `.spectral.yaml: extends: [spectral:oas]` [10][11] | `yamllint . --strict --format parsable`; `spectral lint --format sarif` |
| **JSON/JSONC** | **biome** (13k★) / **oxlint+oxfmt** / **dprint** | Biome handles `json.formatter/linter`; oxlint is Rust 50-100× ESLint; dprint polyglot formatter. This repo uses **oxlint** (type-aware) + `dprint` not yet — oxlint already covers JS/TS. | `biome.json`, `.oxlintrc.json`, `dprint.json: {plugins:[toml,json wasm]}` [12][13] | `biome ci`, `oxlint --deny-warnings`, `dprint check` |
| **MD** | `markdownlint` / `md-wrap` (this repo has `verify-md-wrap`) | - | - | - |

Schema validation pattern: `taplo` respects `$schema` per file or `[[rule]]` HTTP/`taplo://`; `spectral` `oasSchema`/`schema` functions; `biome` `$schema` inference; `ajv-cli`/`check-jsonschema` for pure JSON.

**DSH fit:** Medium. Add `taplo fmt --check` if Cargo expands; add `.yamllint.yaml` + CI for `*.yaml` (many `lefthook.yml`, `pnpm-workspace.yaml`, `.agents/*.i18n.yaml`); JSON already via oxlint/biome lane.

### 2.4 Extended cargo clippy diagnostic — is it relevant?

**Yes — and it's the cheapest diagnostics gain.**

- **What clippy is:** Rust's official lint suite, 8 groups `correctness` (deny-by-default) + `suspicious` + `complexity` + `perf` + `style` + `pedantic` + `restriction` + `nursery`. Controlled via `clippy.toml` (`msrv`, `disallowed-methods`) or `[lints.clippy]` in `Cargo.toml` or `RUSTFLAGS`/`-- -W clippy::pedantic`. [2][3]
- **How it surfaces via LSP today:**
  1. **rust-analyzer `check`:** `rust-analyzer.check.command = "clippy"` + `check.extraArgs = ["--","-W","clippy::pedantic"]` on `textDocument/didSave` (default `check` → `cargo check`). Swap via config, no new binary. [1]
  2. **bacon-ls (GOAT for large workspaces):** `Canop/bacon` + `crisidev/bacon-ls` (216★, 0.29.0) — cargo backend runs `cargo clippy --message-format=json-diagnostic-rendered-ansi` per save/open/close, parses JSON stream, publishes `textDocument/publishDiagnostics` (+ pull `textDocument/diagnostic`). Requires `rust-analyzer.checkOnSave.enable=false; diagnostics.enable=false` to avoid double publish. Streaming refresh `refreshIntervalSeconds:5`. [2]
- **CI gate:** `cargo clippy --all-targets --all-features -- -D warnings` (or `-D clippy::correctness -W clippy::pedantic` cherry-picked; never enable `pedantic`/`nursery`/`restriction` wholesale in CI). [2]
- **Relevance to DSH:** Directly feeds the new `ctx.lspDiagnostics` push-feed — once `lsp-stdio-diagnostics` is configured with `rust-analyzer` + `clippy`, every clippy lint appears as `LspDiagnostic{severity, code, message, range}` with debounce 150 ms + caps 5×20, session event `lsp/diagnostics`, tool `lsp-diagnostics`. No new seam — just a provider `initializationOptions`/`check.command` switch.
- **Gotcha:** `rust-analyzer` and `bacon-ls` compete for `publishDiagnostics`; pick one (r-a default for small; bacon-ls for large `workspace` with many targets). Also need `clippy.toml`/`Cargo.toml [lints]` to pin `msrv` so CI matches editor.

**Recommendation:** Document `rust-analyzer + clippy` as the first `lsp-stdio-diagnostics` deployment example. No code — just a `.agents/notes` snippet + `cordis.patch.yml` example.

### 2.5 Orchestration — trunk / megalinter / lefthook / pre-commit

| Tool | Superpower | Tradeoff | Config | Output |
|------|-----------|----------|--------|--------|
| **Trunk Check** (`trunk-io/trunk`, `trunk-io/plugins` 2k★) — **GOAT for monorepo** | Hermetic daemon + cache, parallel, git-aware `trunk check --filter`, `trunk fmt`, plugins as `sources`, normalizes all linters to one `file:line:col [linter/code]` stream + autofix, SARIF + GitHub annotations via `trunk-action`. | Heavy migration — replaces lefthook + per-tool installs; `trunk Branch` diff hold-the-line; needs `.trunk/trunk.yaml` + runtime declarations. | `.trunk/trunk.yaml: version, cli, plugins.sources, lint.enabled: [clippy, taplo, yamllint, knip]`, `runtimes` [14] | Single unified stream; `post-annotations` |
| **MegaLinter** (`oxsecurity/megalinter` 4.2k★) vs **Super-Linter** (7.5k★) | Docker-batteries-included: 100+ linters in one container, no per-tool install, `ENABLE/DISABLE_LINTERS` env; great for CI without host setup. | Docker overhead, less hermetic caching than trunk, env-driven config noisy. | `.mega-linter.yml: APPLY_FIXES, DISABLE_LINTERS, VALIDATE_ALL_CODEBASE=false` [15] | `megalinter-reports/` SARIF/TAP/JSON + summary |
| **Lefthook** (`evilmartians/lefthook` 4k★, Go, single binary) — **already adopted in DSH** | Fast parallel Git hooks, `glob/exclude/parallel/staged_files`, `lefthook-local.yml` gitignored override, runner `docker` | Hook runner only — no normalization; each job streams own stdout, fails on exit code. | `lefthook.yml: pre-commit.jobs[{name, glob, run, stage_fixed}]`, `pre-push` [16] | Per-job stdout; unification via wrapping `trunk check` inside |
| **pre-commit** (13k★ Python) | Largest hook catalog `.pre-commit-config.yaml`, repo-sharing | Python + slower | `repos: [{rev, hooks:[{id}]}]` | per-hook |

**DSH fit:** Do not replace `lefthook` wholesale yet. Keep lefthook as hook runner; either wrap `trunk check` inside a lefthook job (migration path), or stay with composed jobs (`oxlint`, `knip`, `taplo`, `yamllint`) aggregated manually. If/when lint count grows >8 providers, evaluate trunk — its normalization maps directly to a future unified `ctx.lspDiagnostics` + generic `diagnostics` seam.

---

## 3. GOAT Comparison Matrix (ranked by replication value for DSH)

| Rank | Category | GOAT pick | Stars/adoption | Config file(s) | One-liner install | Diagnostic → DSH mapping |
|------|----------|-----------|----------------|----------------|-------------------|--------------------------|
| **1** | Rust clippy extended | **rust-analyzer check=clippy + bacon-ls cargo backend** | r-a 14k★, bacon 4k★ | `clippy.toml` or `[lints.clippy]`, `rust-analyzer.json` check.command | `rustup component add clippy` | Already LSP Diagnostic (severity 1-4) → `lsp/diagnostics` event, no new seam |
| **2** | Cargo supply-chain | **cargo-deny** (super-set) | 1.2k★, bevy/tokio | `deny.toml` | `cargo install cargo-deny` + `EmbarkStudios/cargo-deny-action` | `json/sarif` → per-file `Cargo.toml`/`Cargo.lock` diagnostics |
| **2b** | Cargo unused | **cargo-shear** | active 1.13.x | `[package.metadata.cargo-shear]` | `cargo binstall cargo-shear` | `Cargo.toml` unused-dep diagnostics |
| **3** | JS/TS unused | **knip** (already adopted) | 8k★ 300k/wk | `knip.json` | `npx knip` | `json` → per-file unused export/dep warnings |
| **3b** | JS/TS vuln | **osv-scanner** (polyglot) | 6k★ | auto (`pnpm-lock.yaml`) | `osv-scanner --recursive` | SARIF → lockfile diagnostics |
| **4** | TOML | **taplo** | 1.6k★ 3.5M dl | `taplo.toml`/`.taplo.toml` | `cargo install taplo-cli` | `taplo lsp stdio` publishDiagnostics or `taplo check --output=json` |
| **5** | YAML | **yamllint** + **spectral** (schema) | yamllint 700★, spectral 3k★ | `.yamllint.yaml`, `.spectral.yaml` | `pip install yamllint`, `npm i -D @stoplight/spectral-cli` | `parsable`/`sarif` → per-YAML diagnostics |
| **6** | JS/TS lint | **oxlint** (already) > biome | oxlint 14k★ | `.oxlintrc.json` | `pnpm lint` | already unified |
| **7** | Monorepo orchestration | **trunk** (hermetic) vs **lefthook** (hook runner) | trunk 2k★, lefthook 4k★ | `.trunk/trunk.yaml` vs `lefthook.yml` | `curl trunk.io/releases/trunk` vs `lefthook install` | trunk normalizes to one stream → future generic `diagnostics` seam |

---

## 4. What This Repo Already Has vs Gaps

| Area | Status in DSH | Gap |
|------|---------------|-----|
| **JS/TS unused** | ✅ `knip.json` + `package.json#knip` script (treatConfigHintsAsErrors) | None — continue |
| **JS/TS lint** | ✅ `oxlint` type-aware + `lefthook` staged fix | Could add `dprint` for TOML/JSON fmt |
| **LSP navigation** | ✅ `ctx.lsp` 4-op + stdio host + `lsp` tool | Done |
| **LSP diagnostics (clippy/TS errors)** | ✅ `ctx.lspDiagnostics` push-feed + `lsp-stdio-diagnostics` + `lsp-diagnostics` tool + `lsp/diagnostics` session event (this sprint) | Needs `rust-analyzer check=clippy` doc example |
| **Rust clippy extended** | ❌ Not configured | Document `check.command="clippy"` + opt `bacon-ls`; add `clippy.toml` + `[lints.clippy]` |
| **Cargo supply-chain** | ❌ No `deny.toml` / no `cargo-deny` CI | Add `deny.toml` + CI `cargo deny check` |
| **Cargo unused** | ❌ No `cargo-shear` | Add `cargo shear` CI (if Cargo workspace grows) |
| **Cargo outdated** | ❌ | Optional cron `cargo outdated` or `bans.multiple-versions=warn` |
| **package.json outdated** | ⚠️ `knip` covers unused; outdated not gated | Optional `ncu` cron or `renovate` bot |
| **package.json vuln** | ⚠️ No `osv-scanner` SARIF | Add `osv-scanner --recursive . --format sarif` CI |
| **TOML lint** | ❌ No `taplo.toml` | Add `taplo fmt --check` |
| **YAML lint** | ❌ No `.yamllint.yaml` / `.spectral.yaml` | Add `yamllint . --strict` (covers `lefthook.yml`, `pnpm-workspace.yaml`) |
| **JSON lint/schema** | ⚠️ Via oxlint; no `biome`/`dprint` JSON fmt | Optional |
| **Orchestration** | ✅ `lefthook.yml` (staged oxlint + notices + whitespace, pre-push typecheck) | Trunk evaluable later; no action now |

---

## 5. Phased Plan (proposed — choose C full sweep or subset)

### Phase 0 — Land without code (this week)

- [ ] Publish this research note + add Chinese sidecar `*.zh.md` + `.i18n.yaml` (verify `verify-agent-note-format`).
- [ ] Docs: extend `docs/subsystems/lsp.md` Diagnostics section with a **Clippy via LSP** deployment example (`rust-analyzer` `check.command: "clippy"`, `clippy.toml` snippet, `bacon-ls` alternative), referencing `packages/lsp/lsp-stdio-diagnostics/README.md`.
- [ ] No version bump — docs-only.

### Phase 1 — Clippy diagnostics via existing seam (P0, low code, high signal)

- [ ] Add `clippy.toml` (or `[lints.clippy]` in `Cargo.toml` if native workspace appears) with `msrv` + cherry-picked `pedantic` warns; document `-W clippy::pedantic` never wholesale in CI.
- [ ] Extend `packages/lsp/lsp-stdio-diagnostics/README.md` with two provider examples: `rust-analyzer` clippy vs `bacon-ls cargo`.
- [ ] CI: if any `Cargo.toml` present, add job `cargo clippy --all-targets -- -D warnings` (or via `rust-analyzer` check gate).
- [ ] Verify: `lsp-diagnostics` tool returns clippy diagnostics after `didChange` (debounce 150 ms, cap 5×20) — reuse existing `lsp-stdio-diagnostics` e2e harness.
- **Effort:** ~1 day, no new package.

### Phase 2 — Dependency health (P1, moderate — not LSP, separate lane)

Two sub-lanes — both produce **non-LSP** diagnostics (lock/manifest scans, not per-range LSP), so they need either (a) a generic `diagnostics` tool/adapter or (b) CI-only gating that emits `session/event` via a nightly tool.

- [ ] **Cargo lane:** add `deny.toml` (advisories/bans/licenses/sources) + `cargo-deny-action` CI; optionally `cargo-shear --fix` check. Config mirrors §2.1.1.
- [ ] **JS lane:** keep `knip`; add `osv-scanner --recursive . --format sarif --output osv.sarif` CI job (+ `npm audit` already via `pnpm audit` if desired). Map SARIF → diagnostics via thin normalizer (file = lockfile, range = 0:0).
- [ ] Design note decision: does DSH need a generic `ctx.diagnostics` seam aggregating LSP *plus* `deny`/`knip`/`osv-scanner` + caps, or is CI-gating + manual `knip` tool enough? Recommendation: **CI-gating first**, generic seam only if unified `lsp/diagnostics` + `deny`/`osv` push to same agent loop observer is required. (Current `lsp/diagnostics` is workspace-scoped `byFile: Record<string, LspDiagnostic[]>` — it can already host `Cargo.toml` file errors if a future `deny-diagnostics-provider` produces them.)
- **Effort:** 2–3 days including `deny.toml` tuning + SARIF normalizer + CI wiring.

### Phase 3 — Generic file lints (P2, low-moderate)

- [ ] `taplo.toml` (`include = ["**/*.toml"]`, `formatting.reorder_keys = false`, `[[rule]]` for `Cargo.toml` reorder), wired as `taplo fmt --check --diff` CI + `taplo lsp stdio` optional second `lsp-diagnostics` provider (if DSH supports multi-provider per workspace — today it's single provider per `workspaceRoot`; would need extension → multi-provider routing evolution).
- [ ] `.yamllint.yaml` (`extends: default`, `rules: {line-length: 120, truthy: disable}`), wired `yamllint . --strict --format parsable` + lefthook staged job `glob: "*.{yaml,yml}"`.
- [ ] Optional `biome.json` or `dprint.json` for JSON fmt (defer — oxlint already covers JS/TS).
- **Effort:** 1 day + lefthook.yml edit + CI wiring.

### Phase 4 — Unified diagnostics seam (P3, strategic — only if Phase 2 proves need)

- [ ] If dependency + file lints both need agent-reactive push (not just CI fail), propose new `dsh-diagnostics` seam (or extend `lsp-diagnostics` to non-LSP `DiagnosticSource` enum: `lsp | cargo-deny | knip | taplo | yamllint`). Dedupe by `{source, code, message, range}`, caps 5×20, same `lsp/diagnostics` session event (or new `diagnostics/update`), same debounce.
- [ ] Evaluate **trunk** migration at this point: trunk already normalizes all above linters to one stream — could replace bespoke adapters with a single `trunk check --format sarif` provider.
- [ ] Decision gate: re-read A/B/C tradeoff from `2026-08-30-lsp-diagnostics-push-feed.md` — the same freshness/accumulation/transcript rules apply to generic diagnostics.

### What NOT to do now

- Do not replace `lefthook` with `trunk` prematurely — migration cost outweighs gain at current linter count (oxlint + knip + typecheck = 3).
- Do not add `cargo-vet` until supply-chain policy matures beyond `cargo-deny` (vet federation is powerful but needs curator time).
- Do not cherry-pick `clippy::pedantic` en masse — whitelist 3–5 pedantic lints, keep default style/perf groups.

---

## 6. Citation Registry

| # | Source | Type | Date seen | Authority |
|---|--------|------|-----------|-----------|
| [1] | [rust-analyzer configuration — `check.command`](https://rust-analyzer.github.io/book/configuration.html) | official (docs) | 2026-08-31 | 9 |
| [2] | [bacon-ls crate docs 0.28 + GitHub crisidev/bacon-ls](https://docs.rs/crate/bacon-ls/0.28.0) / [github](https://github.com/crisidev/bacon-ls) | community (crate+gh) | 2026-08-31 | 7 |
| [3] | [Clippy configuration](https://doc.rust-lang.org/clippy/configuration.html) / [Clippy lints](https://doc.rust-lang.org/clippy/lints.html) | official (rust-lang) | 2026-08-31 | 9 |
| [4] | [cargo-deny advisories/bans/licenses/sources cfg](https://embarkstudios.github.io/cargo-deny/checks/advisories/cfg.html) (+ bans/licenses/sources siblings) | official (embark) | 2026-08-31 | 9 |
| [5] | [knip.dev overview/config](https://knip.dev/overview/first-cleanup) / [knip vs depcheck pkgpulse](https://www.pkgpulse.com/blog/knip-vs-depcheck-2026) | official + industry | 2026-08-31 | 8 |
| [6] | [osv-scanner vs npm audit comparison (jit.io)](https://www.jit.io/resources/appsec-tools/osv-scanner-vs-npm-audit-a-detailed-comparison-of-sca-tools) / [google/osv-scanner](https://google.github.io/osv-scanner/) | industry | 2026-08-31 | 7 |
| [7] | [cargo-shear crate docs 1.2.0](https://docs.rs/crate/cargo-shear/1.2.0) (Boshen) | community (crate) | 2026-08-31 | 7 |
| [8] | [cargo audit vs cargo deny comparison (safeguard.sh)](https://safeguard.sh/resources/blog/cargo-audit-vs-cargo-deny-comparison) / [rustsec/rustsec](https://github.com/RustSec/rustsec) | industry | 2026-08-31 | 7 |
| [9] | [Taplo config file spec](https://taplo.tamasfe.dev/configuration/file.html) | official | 2026-08-31 | 8 |
| [10] | [yamllint configuration](https://yamllint.readthedocs.io/en/stable/configuration.html) | official | 2026-08-31 | 8 |
| [11] | [Spectral rulesets / stoplightio/spectral](https://raw.githubusercontent.com/stoplightio/spectral/87411e1a9b8d774e24a44363910d4588d26c9c12/docs/rulesets.md) | official | 2026-08-31 | 7 |
| [12] | [Biome configure](https://v1.biomejs.dev/guides/configure-biome/) | official | 2026-08-31 | 7 |
| [13] | [dprint TOML plugin](https://dprint.dev/plugins/toml/) / [Oxlint config](https://oxc.rs/docs/guide/usage/linter/config.html) | official | 2026-08-31 | 7 |
| [14] | [Trunk — run linters / configuration / linting in CI](https://docs.trunk.io/code-quality/overview/linters/run-linters) + hierarchy + trunk-action | official | 2026-08-31 | 8 |
| [15] | [MegaLinter vs Super-Linter](https://megalinter.io/9.4.0/mega-linter-vs-super-linter/) | official | 2026-08-31 | 7 |
| [16] | [Lefthook README / configuration](https://raw.githubusercontent.com/evilmartians/lefthook/master/README.md) / [lefthook.dev](https://lefthook.dev/configuration/index) | official | 2026-08-31 | 8 |

Dropped: docs.rs version-list pages (too verbose) and several marketing blogs — not load-bearing.

---

## 7. Limitations & What Could Not Be Verified

- **Time-sensitive** `stars`/`downloads` are Aug 2026 snapshots — recheck before quoting externally.
- **Native Cargo presence:** this repo's root has no `Cargo.toml` inspected (native/landlock-run may carry one); deny/shear plan assumes future Rust crate growth.
- **`bacon-ls` authority:** only 216★, not "GOAT" by stars — GOAT here means "best push-diagnostics companion to rust-analyzer for large workspaces," not popularity.
- **Trunk plugin reuse:** not verified that `trunk`'s `clippy` plugin honors `clippy.toml` `msrv` identically to raw `cargo clippy` — assume it delegates verbatim (per docs claim) but needs spot check.

## 8. Counter-evidence

- Some teams succeed with **only `oxlint` + `tsc` + `knip` + `lefthook`** (this repo's current stack) without trunk/deny — proving monorepo orchestration is optional until linter count >6.
- **`cargo-vet` advocates** argue deny's license allowlist is too coarse for supply-chain trust — hence vet's per-crate audit criteria. This research ranks deny first (pragmatic), vet second (strategic) — opposite ranking valid for high-assurance crates.
- **`clippy::pedantic` skeptics** warn that enabling pedantic even cherry-picked adds churn; alternative is keep default 4 groups (correctness/suspicious/complexity/perf/style) and add restricts via `#[warn]` locally.

---

## 9. Next Step (recommendation)

Adopt **Phase 0 + 1 now** (clippy via existing seam, zero new package), **Phase 2 deny + osv-scanner** next sprint, **Phase 3 taplo/yamllint** oportunistically, **Phase 4 unified seam only if agent needs reactive push for non-LSP diagnostics** (otherwise CI gates suffice). This mirrors the A→B→C progression of the LSP diagnostics note — smallest push first.
