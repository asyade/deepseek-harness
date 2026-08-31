# GOAT 检测与诊断——深度研究（cargo / npm / 通用文件 / clippy）

[English](2026-08-31-goat-lint-diagnostics.md) | 中文

**截至：** 2026-08-31

**受众：** DSH 维护者——在 LSP 诊断推送流（`packages/lsp/lsp-diagnostics` + `lsp-stdio-diagnostics` + `tool-lsp-diagnostics`）之后，决定接下来要添加哪些 lint/诊断表面。

**逐字提问：** *"Lint for cargo.toml (deprecated/old deps) same for package.json + vulnerables (optional), More lint for other languages/files (json,yaml etc), Do we have extended cargo clippy diagnostic? is it relevant to add → Do online search for various similar prior art/work i'm sure there is tones and find the goat/top patterns to replicate."*

**风险等级：** 中——正确性 + 供应链卫生；选错 = 浪费 CI 分钟或产生噪音诊断。

> **先给直接答案：** 是——三项扩展都值得做，但分属不同赛道：
> 1. **Clippy 扩展诊断 = 经现有 LSP seam 立即可得** —— 只需配置 `rust-analyzer.check.command="clippy"`（大工作区用 `bacon-ls` cargo 后端）；除文档/配置外无需新 DSH 代码。GOAT：`rust-analyzer` + `clippy` + 可选 `bacon-ls`。[1][2][3]
> 2. **Cargo.toml / package.json 弃用与漏洞 lint = 独立的"依赖健康"赛道** —— 非 LSP；Cargo 用 `cargo-deny`（超集）+ `cargo shear/machete/udeps`，JS/TS 用 `knip` + `osv-scanner`（或 `npm audit`）。GOAT：`cargo-deny` + `cargo-shear` + `knip` + `osv-scanner`。[4][5][6][7][8]
> 3. **通用文件 lint（json/yaml/toml）= 格式化器 + schema 赛道** —— TOML 用 `taplo`，YAML/JSON 用 `yamllint` + `spectral`，本仓库的 JS/TS 已由 `biome`/`oxlint`/`dprint` 覆盖。GOAT：`taplo` + `yamllint` + `spectral` + `biome`/`dprint`。[9][10][11][12][13]
> 4. **编排 GOAT = trunk vs megalinter vs lefthook/pre-commit** —— 对 monorepo，`trunk check` 是规范化所有 linter 的密封通用检查器；`megalinter` 是 Docker 全家桶替代方案；`lefthook`（本仓库已采用）是钩子运行器。DSH 已用 `lefthook` + `oxlint` + `knip`；加 `trunk` 会取代它们但迁移成本高。[14][15][16]

置信度：clippy 与 cargo-deny/knip/taplo 为**高**（文档完善、引用多）；编排排序为**中**（trunk 热度上升但 lefthook 在本仓库已根深蒂固）。

---

## 1. 方法

5 条并行研究线（workflow `goat-diagnostics-research`）——每条运行 2–4 次 `web_search` 查询、抓取 2–3 个最佳来源、提炼为事实/分析/缺口。来源去重进入 §6 注册表。无需浏览器自动化；`web_fetch` 对关键页面成功。以下所有论断均引用注册表编号。

线程：
- `cargo-deny/audit/vet/supply-chain`
- `cargo-clippy/bacon-ls/rust-analyzer`
- `package.json-knip-depcheck`
- `taplo-toml-yaml-json`（通用文件 lints）
- `trunk-megalinter-orchestration`

本地工作区检查：`lefthook.yml`（staged oxlint + 空白 + 第三方通知，pre-push typecheck）、`knip.json`（已配置，`treatConfigHintsAsErrors`）、`.oxlintrc.json`（类型感知）、尚无 `deny.toml`/`cargo-deny`、无 `taplo.toml`/`yamllint`。根目录是 pnpm workspace——仓库根没有 Rust `Cargo.toml`（native/landlock-run 可能有），但威胁模型仍然适用。

---

## 2. 详细发现

### 2.1 Cargo.toml lint——弃用 / 过时 / 未使用 / 漏洞

| 目标 | GOAT 工具 | 为何是 GOAT | 配置 | CI | 输出 → 诊断 |
|------|-----------|----------|--------|----|---------------------|
| **漏洞 + 禁止 + 许可证 + 来源**（超集） | **EmbarkStudios/cargo-deny**（约 1.2k★，`bevy`/`tokio` 使用） | 一个 `deny.toml` 带 4 项检查：`[advisories]`（RustSec DB）、`[bans]`（拒绝/跳过重复、通配符）、`[licenses]`（白名单 + 例外）、`[sources]`（registry/git）。在 advisory 上取代 cargo-audit *且* 增加策略。 [4] | `deny.toml`——见 §2.1.1 | `cargo deny check advisories bans licenses sources` 或 `EmbarkStudios/cargo-deny-action`；缓存 `~/.cargo/advisory-dbs` | `--format json/sarif` → `level: deny/warn`、`code: bans.duplicate`、`spans` → 映射 `deny→error` |
| **仅 advisory（最轻）** | **rustsec/cargo-audit**（`rustsec/audit-check@v1`） | 单一用途 advisory 扫描器，零策略。不想用 deny 的另外 3 项检查时适用。 | 无（读 `Cargo.lock` + advisory DB） | `rustsec/audit-check@v1` 每晚 cron | `--json` → `vulnerabilities[{advisory.id, cvss}]` → 非空即 error |
| **供应链审计**（人工审核） | **mozilla/cargo-vet**（约 1k★） | Mozilla 的共享 `audits.toml` 联邦（`safe-to-run`/`safe-to-deploy`）。补充 deny/audit，非取代。 | `supply-chain/config.toml` + `audits.toml` + `imports.lock` | `cargo vet --locked` | `failures` + `suggest` → 直到 `certify` 才 error |
| **未使用依赖**（Cargo.toml 卫生） | **cargo-shear**（Boshen，活跃，1.13.x）> cargo-machete > cargo-udeps（停滞） | `cargo-shear` 经 `syn` 解析 + `cargo_metadata`，`--fix` 重写 TOML，CI 对未使用退出 1。处理 workspace 根。Machete 仅正则会漏；udeps 需完整编译且在新 cargo 上损坏。 [7] | `Cargo.toml [package.metadata.cargo-shear] ignored = ["crate"]` | `cargo binstall cargo-shear && cargo shear` | 退出 1 + 未使用 crate 列表 → `Cargo.toml` 上的按文件诊断 |
| **过时** | **cargo-outdated** / `cargo update --dry-run` + `cargo deny bans multiple-versions = "warn"` | deny 的 `multiple-versions` warn 捕获重复 semver；`cargo outdated -R` 列出落后于最新的 spec。不感知漏洞。 | `bans.multiple-versions = "warn"` | cron `cargo outdated` | warn 列表 |

#### 2.1.1 `deny.toml` 形状（Embark spec） [4]

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

**DSH 契合度：** 高。在仓库根添加 `deny.toml` + CI 任务 `cargo deny check`。即使根目录无 Cargo，`deny` 也会校验 `Cargo.lock` 是否存在；对 JS 为主的 harness，`knip`/`osv-scanner` 更重要，但现在落地 deny 可防止未来 native/ crate 漂移。

### 2.2 package.json lint——弃用 / 过时 / 未使用 / 漏洞

| 目标 | GOAT 工具 | 为何是 GOAT | 配置 | CI | 输出 → 诊断 |
|------|-----------|----------|--------|----|---------------------|
| **未使用的依赖/导出/文件**（JS/TS 图） | **webpro-nl/knip**（8k★，300k 下载/周，182 插件）——**GOAT** | 完整导入/导出图，不只是 `package.json` 扫描。发现 7 类：未使用文件/导出/类型、未使用 deps/devDeps、未列出、重复、未解析、二进制。取代 `depcheck`/`unimported`。本仓库已启用（`knip.json`，`package.json: knip --treat-config-hints-as-errors`）。 | `knip.json` §2.2.1 | `npx knip --reporter json`（或 `github-actions`） | `json: {files, issues[{file,line,col,name}]}` → `warning`，`rule: knip/<type>` |
| **未使用依赖（轻）** | **depcheck**（4.5k★） | 零配置 `require/import` 扫描器。更快，但无导出/monorepo 感知。 | `.depcheckrc: {ignores, ignorePatterns}` | `npx depcheck --json` | `missing:{pkg:[file]}` |
| **漏洞** | **google/osv-scanner**（6k★，SARIF，30+ 锁文件）vs `npm audit` | `osv-scanner` 多语言、OSV.dev DB、SLSA3；`npm audit` 仅 npm。两者都用：`npm audit` 快速，`osv-scanner` CI 级。 | 无 / `--lockfile` | `osv-scanner --recursive . --format sarif` / `npm audit --json` | SARIF `results[].package+vuln.id` → error |
| **过时** | **npm-check-updates（`ncu`）** / `npm outdated` + `renovate`/`dependabot` | 列出落后 semver。不感知漏洞。 | `.ncurc.json` | cron `ncu` | warn 列表 |

#### 2.2.1 `knip.json` 形状（本仓库已有） [5]

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

**DSH 契合度：** 已采用——保持。下一步：在 `npm audit` 旁（`pnpm audit` 已隐含）加 `osv-scanner` SARIF 任务。

### 2.3 通用文件 lints——JSON / YAML / TOML / MD

| 文件类型 | GOAT 工具 | 为何是 GOAT | 配置 | CI |
|----------|-----------|----------|--------|----|
| **TOML**（Cargo.toml、taplo.toml） | **tamasfe/taplo**（Rust，1.6k★，LSP + `taplo://` schema 存储） | 格式化器 + linter + LSP（`taplo lsp stdio` → `publishDiagnostics`）。替代：`dprint+toml` wasm。 | `taplo.toml: include, [formatting] reorder_keys, [schema]`、`[[rule]]` 按路径 | `taplo fmt --check --diff` / `taplo check --output=json` [9] |
| **YAML** | **adrienverge/yamllint**（pre-commit 常客）+ **spectral** 做 schema | yamllint = 纯 lint（无格式化），经 `rules: {line-length, indentation}`；spectral = JSON/YAML schema linter（OpenAPI/AsyncAPI + 自定义 JSON Schema，函数 `pattern/truthy/schema`）。yamllint + prettier/dprint 配对做格式化。 | `.yamllint.yaml: extends: default, rules: {...}`；`.spectral.yaml: extends: [spectral:oas]` [10][11] | `yamllint . --strict --format parsable`；`spectral lint --format sarif` |
| **JSON/JSONC** | **biome**（13k★）/ **oxlint+oxfmt** / **dprint** | Biome 处理 `json.formatter/linter`；oxlint 是 Rust 的 50–100× ESLint；dprint 多语言格式化器。本仓库用 **oxlint**（类型感知）+ 尚未用 `dprint`——oxlint 已覆盖 JS/TS。 | `biome.json`、`.oxlintrc.json`、`dprint.json: {plugins:[toml,json wasm]}` [12][13] | `biome ci`、`oxlint --deny-warnings`、`dprint check` |
| **MD** | `markdownlint` / `md-wrap`（本仓库有 `verify-md-wrap`） | - | - | - |

Schema 校验模式：`taplo` 尊重每个文件的 `$schema` 或 `[[rule]]` HTTP/`taplo://`；`spectral` 的 `oasSchema`/`schema` 函数；`biome` 的 `$schema` 推断；纯 JSON 用 `ajv-cli`/`check-jsonschema`。

**DSH 契合度：** 中。Cargo 扩展时加 `taplo fmt --check`；为 `*.yaml` 加 `.yamllint.yaml` + CI（许多 `lefthook.yml`、`pnpm-workspace.yaml`、`.agents/*.i18n.yaml`）；JSON 已走 oxlint/biome 赛道。

<a id="24-extended-cargo-clippy-diagnostic--is-it-relevant"></a>

### 2.4 扩展 cargo clippy 诊断——相关吗？

**相关——而且是最便宜的诊断收益。**

- **clippy 是什么：** Rust 官方 lint 套件，8 组：`correctness`（默认 deny）+ `suspicious` + `complexity` + `perf` + `style` + `pedantic` + `restriction` + `nursery`。经 `clippy.toml`（`msrv`、`disallowed-methods`）或 `Cargo.toml` 的 `[lints.clippy]` 或 `RUSTFLAGS`/`-- -W clippy::pedantic` 控制。[2][3]
- **今天如何经 LSP 呈现：**
  1. **rust-analyzer `check`：** `rust-analyzer.check.command = "clippy"` + `check.extraArgs = ["--","-W","clippy::pedantic"]`，在 `textDocument/didSave` 上（默认 `check` → `cargo check`）。经配置切换，无需新二进制。[1]
  2. **bacon-ls（大工作区的 GOAT）：** `Canop/bacon` + `crisidev/bacon-ls`（216★，0.29.0）——cargo 后端在每次保存/打开/关闭时运行 `cargo clippy --message-format=json-diagnostic-rendered-ansi`，解析 JSON 流，发布 `textDocument/publishDiagnostics`（+ 拉取 `textDocument/diagnostic`）。需要 `rust-analyzer.checkOnSave.enable=false; diagnostics.enable=false` 以避免重复发布。流式刷新 `refreshIntervalSeconds:5`。[2]
- **CI 门禁：** `cargo clippy --all-targets --all-features -- -D warnings`（或挑选 `-D clippy::correctness -W clippy::pedantic`；绝不在 CI 中整体启用 `pedantic`/`nursery`/`restriction`）。[2]
- **对 DSH 的相关性：** 直接喂入新的 `ctx.lspDiagnostics` 推送流——一旦 `lsp-stdio-diagnostics` 配置了 `rust-analyzer` + `clippy`，每个 clippy lint 都会以 `LspDiagnostic{severity, code, message, range}` 出现，防抖 150 ms + 截断 5×20，会话事件 `lsp/diagnostics`、工具 `lsp-diagnostics`。无新 seam——只是提供方 `initializationOptions`/`check.command` 切换。
- **陷阱：** `rust-analyzer` 与 `bacon-ls` 竞争 `publishDiagnostics`；二选一（小工作区默认 r-a；多 target 大 `workspace` 用 bacon-ls）。还需 `clippy.toml`/`Cargo.toml [lints]` 固定 `msrv` 使 CI 与编辑器一致。

**建议：** 把 `rust-analyzer + clippy` 记录为第一个 `lsp-stdio-diagnostics` 部署示例。零代码——只是一段 `.agents/notes` 片段 + `cordis.patch.yml` 示例。

### 2.5 编排——trunk / megalinter / lefthook / pre-commit

| 工具 | 超能力 | 权衡 | 配置 | 输出 |
|------|-----------|----------|--------|--------|
| **Trunk Check**（`trunk-io/trunk`、`trunk-io/plugins` 2k★）——**monorepo 的 GOAT** | 密封守护进程 + 缓存、并行、git 感知的 `trunk check --filter`、`trunk fmt`、插件作 `sources`、把所有 linter 规范化为单一 `file:line:col [linter/code]` 流 + 自动修复、经 `trunk-action` 输出 SARIF + GitHub 注解。 | 迁移重——取代 lefthook + 按工具安装；`trunk Branch` diff 保持底线；需要 `.trunk/trunk.yaml` + 运行时声明。 | `.trunk/trunk.yaml: version, cli, plugins.sources, lint.enabled: [clippy, taplo, yamllint, knip]`、`runtimes` [14] | 单一统一流；`post-annotations` |
| **MegaLinter**（`oxsecurity/megalinter` 4.2k★）vs **Super-Linter**（7.5k★） | Docker 全家桶：一个容器 100+ linter，无需按工具安装，`ENABLE/DISABLE_LINTERS` 环境变量；适合无主机配置的 CI。 | Docker 开销、密封缓存弱于 trunk、环境变量驱动配置嘈杂。 | `.mega-linter.yml: APPLY_FIXES, DISABLE_LINTERS, VALIDATE_ALL_CODEBASE=false` [15] | `megalinter-reports/` SARIF/TAP/JSON + 摘要 |
| **Lefthook**（`evilmartians/lefthook` 4k★，Go，单二进制）——**DSH 已采用** | 快速并行 Git 钩子、`glob/exclude/parallel/staged_files`、`lefthook-local.yml` gitignore 覆盖、runner `docker` | 只是钩子运行器——无规范化；每个任务流式输出自己的 stdout，按退出码失败。 | `lefthook.yml: pre-commit.jobs[{name, glob, run, stage_fixed}]`、`pre-push` [16] | 按任务 stdout；在内部包装 `trunk check` 统一 |
| **pre-commit**（13k★ Python） | 最大钩子目录 `.pre-commit-config.yaml`、仓库共享 | Python + 较慢 | `repos: [{rev, hooks:[{id}]}]` | 按钩子 |

**DSH 契合度：** 暂不整体替换 `lefthook`。保留 lefthook 作钩子运行器；要么在 lefthook 任务内包装 `trunk check`（迁移路径），要么继续组合任务（`oxlint`、`knip`、`taplo`、`yamllint`）手动聚合。若 lint 数量增至 >8 个提供方，再评估 trunk——其规范化可直接映射到未来统一的 `ctx.lspDiagnostics` + 通用 `diagnostics` seam。

---

## 3. GOAT 对比矩阵（按对 DSH 的复制价值排序）

| 排名 | 类别 | GOAT 选择 | 星标/采用 | 配置文件 | 一行安装 | 诊断 → DSH 映射 |
|------|----------|-----------|----------------|----------------|-------------------|--------------------------|
| **1** | Rust clippy 扩展 | **rust-analyzer check=clippy + bacon-ls cargo 后端** | r-a 14k★，bacon 4k★ | `clippy.toml` 或 `[lints.clippy]`、`rust-analyzer.json` check.command | `rustup component add clippy` | 已是 LSP Diagnostic（severity 1-4）→ `lsp/diagnostics` 事件，无新 seam |
| **2** | Cargo 供应链 | **cargo-deny**（超集） | 1.2k★，bevy/tokio | `deny.toml` | `cargo install cargo-deny` + `EmbarkStudios/cargo-deny-action` | `json/sarif` → 按文件 `Cargo.toml`/`Cargo.lock` 诊断 |
| **2b** | Cargo 未使用 | **cargo-shear** | 活跃 1.13.x | `[package.metadata.cargo-shear]` | `cargo binstall cargo-shear` | `Cargo.toml` 未使用依赖诊断 |
| **3** | JS/TS 未使用 | **knip**（已采用） | 8k★ 300k/周 | `knip.json` | `npx knip` | `json` → 按文件未使用导出/依赖警告 |
| **3b** | JS/TS 漏洞 | **osv-scanner**（多语言） | 6k★ | 自动（`pnpm-lock.yaml`） | `osv-scanner --recursive` | SARIF → 锁文件诊断 |
| **4** | TOML | **taplo** | 1.6k★ 3.5M 下载 | `taplo.toml`/`.taplo.toml` | `cargo install taplo-cli` | `taplo lsp stdio` publishDiagnostics 或 `taplo check --output=json` |
| **5** | YAML | **yamllint** + **spectral**（schema） | yamllint 700★，spectral 3k★ | `.yamllint.yaml`、`.spectral.yaml` | `pip install yamllint`、`npm i -D @stoplight/spectral-cli` | `parsable`/`sarif` → 按 YAML 诊断 |
| **6** | JS/TS lint | **oxlint**（已有）> biome | oxlint 14k★ | `.oxlintrc.json` | `pnpm lint` | 已统一 |
| **7** | monorepo 编排 | **trunk**（密封）vs **lefthook**（钩子运行器） | trunk 2k★，lefthook 4k★ | `.trunk/trunk.yaml` vs `lefthook.yml` | `curl trunk.io/releases/trunk` vs `lefthook install` | trunk 规范化为单一流 → 未来通用 `diagnostics` seam |

---

## 4. 本仓库已有 vs 缺口

| 领域 | DSH 状态 | 缺口 |
|------|---------------|-----|
| **JS/TS 未使用** | ✅ `knip.json` + `package.json#knip` 脚本（treatConfigHintsAsErrors） | 无——继续 |
| **JS/TS lint** | ✅ `oxlint` 类型感知 + `lefthook` staged 修复 | 可为 TOML/JSON 格式化加 `dprint` |
| **LSP 导航** | ✅ `ctx.lsp` 4 操作 + stdio 宿主 + `lsp` 工具 | 完成 |
| **LSP 诊断（clippy/TS 错误）** | ✅ `ctx.lspDiagnostics` 推送流 + `lsp-stdio-diagnostics` + `lsp-diagnostics` 工具 + `lsp/diagnostics` 会话事件（本次 sprint） | 需要 `rust-analyzer check=clippy` 文档示例 |
| **Rust clippy 扩展** | ❌ 未配置 | 记录 `check.command="clippy"` + 可选 `bacon-ls`；加 `clippy.toml` + `[lints.clippy]` |
| **Cargo 供应链** | ❌ 无 `deny.toml` / 无 `cargo-deny` CI | 加 `deny.toml` + CI `cargo deny check` |
| **Cargo 未使用** | ❌ 无 `cargo-shear` | 加 `cargo shear` CI（Cargo workspace 增长时） |
| **Cargo 过时** | ❌ | 可选 cron `cargo outdated` 或 `bans.multiple-versions=warn` |
| **package.json 过时** | ⚠️ `knip` 覆盖未使用；过时未门禁 | 可选 `ncu` cron 或 `renovate` 机器人 |
| **package.json 漏洞** | ⚠️ 无 `osv-scanner` SARIF | 加 `osv-scanner --recursive . --format sarif` CI |
| **TOML lint** | ❌ 无 `taplo.toml` | 加 `taplo fmt --check` |
| **YAML lint** | ❌ 无 `.yamllint.yaml` / `.spectral.yaml` | 加 `yamllint . --strict`（覆盖 `lefthook.yml`、`pnpm-workspace.yaml`） |
| **JSON lint/schema** | ⚠️ 经 oxlint；无 `biome`/`dprint` JSON fmt | 可选 |
| **编排** | ✅ `lefthook.yml`（staged oxlint + 通知 + 空白，pre-push typecheck） | trunk 以后评估；现在不动 |

---

## 5. 分阶段计划（提议——选 C 全面清扫或子集）

### 阶段 0——零代码落地（本周）

- [ ] 发布本研究笔记 + 添加中文对侧 `*.zh.md` + `.i18n.yaml`（验证 `verify-agent-note-format`）。
- [ ] 文档：在 `docs/subsystems/lsp.md` 的 Diagnostics 部分扩展一个 **Clippy via LSP** 部署示例（`rust-analyzer` `check.command: "clippy"`、`clippy.toml` 片段、`bacon-ls` 替代方案），引用 `packages/lsp/lsp-stdio-diagnostics/README.md`。
- [ ] 不升版本号——仅文档。

### 阶段 1——经现有 seam 的 Clippy 诊断（P0，低代码，高信号）

- [ ] 添加 `clippy.toml`（或 native workspace 出现时在 `Cargo.toml` 的 `[lints.clippy]`）带 `msrv` + 挑选的 `pedantic` warns；记录 `-W clippy::pedantic` 绝不在 CI 中整体启用。
- [ ] 扩展 `packages/lsp/lsp-stdio-diagnostics/README.md`，加两个提供方示例：`rust-analyzer` clippy vs `bacon-ls cargo`。
- [ ] CI：若存在任何 `Cargo.toml`，加任务 `cargo clippy --all-targets -- -D warnings`（或经 `rust-analyzer` check 门禁）。
- [ ] 验证：`lsp-diagnostics` 工具在 `didChange` 后返回 clippy 诊断（防抖 150 ms、截断 5×20）——复用现有 `lsp-stdio-diagnostics` e2e 测试台。
- **工作量：** 约 1 天，无新包。

### 阶段 2——依赖健康（P1，中等——非 LSP，独立赛道）

两条子赛道——都产生**非 LSP** 诊断（锁/清单扫描，非按范围 LSP），因此需要 (a) 通用 `diagnostics` 工具/适配器或 (b) 仅 CI 门禁，经夜间工具发出 `session/event`。

- [ ] **Cargo 赛道：** 加 `deny.toml`（advisories/bans/licenses/sources）+ `cargo-deny-action` CI；可选 `cargo-shear --fix` 检查。配置镜像 §2.1.1。
- [ ] **JS 赛道：** 保留 `knip`；加 `osv-scanner --recursive . --format sarif --output osv.sarif` CI 任务（+ 如需 `npm audit` 已经 `pnpm audit`）。经薄规范化器把 SARIF 映射为诊断（文件 = 锁文件，range = 0:0）。
- [ ] 设计笔记决策：DSH 是否需要聚合 LSP *加* `deny`/`knip`/`osv-scanner` + 截断的通用 `ctx.diagnostics` seam，还是 CI 门禁 + 手动 `knip` 工具足够？建议：**先 CI 门禁**，只有统一 `lsp/diagnostics` + `deny`/`osv` 需要推送到同一 agent loop 观察者时才建通用 seam。（当前 `lsp/diagnostics` 是工作区范围的 `byFile: Record<string, LspDiagnostic[]>`——若未来 `deny-diagnostics-provider` 产生它们，它已经可以承载 `Cargo.toml` 文件错误。）
- **工作量：** 2–3 天，含 `deny.toml` 调优 + SARIF 规范化器 + CI 接线。

### 阶段 3——通用文件 lints（P2，低-中）

- [ ] `taplo.toml`（`include = ["**/*.toml"]`、`formatting.reorder_keys = false`、`Cargo.toml` reorder 的 `[[rule]]`），接线为 `taplo fmt --check --diff` CI + 可选第二个 `lsp-diagnostics` 提供方 `taplo lsp stdio`（若 DSH 支持每工作区多提供方——今天每 `workspaceRoot` 单提供方；需要扩展 → 多提供方路由演进）。
- [ ] `.yamllint.yaml`（`extends: default`、`rules: {line-length: 120, truthy: disable}`），接线 `yamllint . --strict --format parsable` + lefthook staged 任务 `glob: "*.{yaml,yml}"`。
- [ ] 可选 `biome.json` 或 `dprint.json` 做 JSON fmt（推迟——oxlint 已覆盖 JS/TS）。
- **工作量：** 1 天 + lefthook.yml 编辑 + CI 接线。

### 阶段 4——统一诊断 seam（P3，战略——仅当阶段 2 证明需要）

- [ ] 若依赖与文件 lints 都需要 agent 响应式推送（不只是 CI 失败），提议新 `dsh-diagnostics` seam（或把 `lsp-diagnostics` 扩展为带非 LSP `DiagnosticSource` 枚举：`lsp | cargo-deny | knip | taplo | yamllint`）。按 `{source, code, message, range}` 去重、截断 5×20、同一 `lsp/diagnostics` 会话事件（或新 `diagnostics/update`）、同一防抖。
- [ ] 此时评估 **trunk** 迁移：trunk 已把上述所有 linter 规范化为单一流——可用单一 `trunk check --format sarif` 提供方取代定制适配器。
- [ ] 决策门禁：重读 `2026-08-30-lsp-diagnostics-push-feed.md` 的 A/B/C 权衡——同样的新鲜度/累积/转录规则适用于通用诊断。

### 现在不做的事

- 不要过早用 `trunk` 替换 `lefthook`——在当前 linter 数量（oxlint + knip + typecheck = 3）下迁移成本大于收益。
- 供应链策略成熟到 `cargo-deny` 之前不要加 `cargo-vet`（vet 联邦强大但需要策展人时间）。
- 不要成批挑选 `clippy::pedantic`——白名单 3–5 个 pedantic lints，保留默认 style/perf 组。

---

## 6. 引用注册表

| # | 来源 | 类型 | 看到日期 | 权威度 |
|---|--------|------|-----------|-----------|
| [1] | [rust-analyzer configuration — `check.command`](https://rust-analyzer.github.io/book/configuration.html) | 官方（docs） | 2026-08-31 | 9 |
| [2] | [bacon-ls crate docs 0.28 + GitHub crisidev/bacon-ls](https://docs.rs/crate/bacon-ls/0.28.0) / [github](https://github.com/crisidev/bacon-ls) | 社区（crate+gh） | 2026-08-31 | 7 |
| [3] | [Clippy configuration](https://doc.rust-lang.org/clippy/configuration.html) / [Clippy lints](https://doc.rust-lang.org/clippy/lints.html) | 官方（rust-lang） | 2026-08-31 | 9 |
| [4] | [cargo-deny advisories/bans/licenses/sources cfg](https://embarkstudios.github.io/cargo-deny/checks/advisories/cfg.html)（+ bans/licenses/sources 姊妹页） | 官方（embark） | 2026-08-31 | 9 |
| [5] | [knip.dev overview/config](https://knip.dev/overview/first-cleanup) / [knip vs depcheck pkgpulse](https://www.pkgpulse.com/blog/knip-vs-depcheck-2026) | 官方 + 行业 | 2026-08-31 | 8 |
| [6] | [osv-scanner vs npm audit comparison (jit.io)](https://www.jit.io/resources/appsec-tools/osv-scanner-vs-npm-audit-a-detailed-comparison-of-sca-tools) / [google/osv-scanner](https://google.github.io/osv-scanner/) | 行业 | 2026-08-31 | 7 |
| [7] | [cargo-shear crate docs 1.2.0](https://docs.rs/crate/cargo-shear/1.2.0)（Boshen） | 社区（crate） | 2026-08-31 | 7 |
| [8] | [cargo audit vs cargo deny comparison (safeguard.sh)](https://safeguard.sh/resources/blog/cargo-audit-vs-cargo-deny-comparison) / [rustsec/rustsec](https://github.com/RustSec/rustsec) | 行业 | 2026-08-31 | 7 |
| [9] | [Taplo config file spec](https://taplo.tamasfe.dev/configuration/file.html) | 官方 | 2026-08-31 | 8 |
| [10] | [yamllint configuration](https://yamllint.readthedocs.io/en/stable/configuration.html) | 官方 | 2026-08-31 | 8 |
| [11] | [Spectral rulesets / stoplightio/spectral](https://raw.githubusercontent.com/stoplightio/spectral/87411e1a9b8d774e24a44363910d4588d26c9c12/docs/rulesets.md) | 官方 | 2026-08-31 | 7 |
| [12] | [Biome configure](https://v1.biomejs.dev/guides/configure-biome/) | 官方 | 2026-08-31 | 7 |
| [13] | [dprint TOML plugin](https://dprint.dev/plugins/toml/) / [Oxlint config](https://oxc.rs/docs/guide/usage/linter/config.html) | 官方 | 2026-08-31 | 7 |
| [14] | [Trunk — run linters / configuration / linting in CI](https://docs.trunk.io/code-quality/overview/linters/run-linters) + hierarchy + trunk-action | 官方 | 2026-08-31 | 8 |
| [15] | [MegaLinter vs Super-Linter](https://megalinter.io/9.4.0/mega-linter-vs-super-linter/) | 官方 | 2026-08-31 | 7 |
| [16] | [Lefthook README / configuration](https://raw.githubusercontent.com/evilmartians/lefthook/master/README.md) / [lefthook.dev](https://lefthook.dev/configuration/index) | 官方 | 2026-08-31 | 8 |

已丢弃：docs.rs 版本列表页（过冗）与若干营销博客——非承重。

---

## 7. 局限与未能验证

- **时间敏感** 的 `stars`/`downloads` 是 2026 年 8 月快照——对外引用前重新检查。
- **native Cargo 存在性：** 本仓库根未见 `Cargo.toml` 检查（native/landlock-run 可能带一个）；deny/shear 计划假设未来 Rust crate 增长。
- **`bacon-ls` 权威度：** 仅 216★，按星标不算 "GOAT"——此处的 GOAT 指"大工作区下 rust-analyzer 的最佳推送诊断伴侣"，而非流行度。
- **Trunk 插件复用：** 未验证 `trunk` 的 `clippy` 插件是否与原始 `cargo clippy` 完全一致地尊重 `clippy.toml` 的 `msrv`——按文档声称假定其逐字委派，但需要抽查。

## 8. 反证

- 有些团队只用 **`oxlint` + `tsc` + `knip` + `lefthook`**（本仓库当前栈）就成功，无需 trunk/deny——证明 monorepo 编排在 linter 数量 >6 前是可选的。
- **`cargo-vet` 拥护者** 认为 deny 的许可证白名单对供应链信任过于粗糙——故有 vet 的按 crate 审计标准。本研究把 deny 排第一（务实）、vet 第二（战略）——对高保证 crate 相反排序同样成立。
- **`clippy::pedantic` 怀疑者** 警告即使挑选启用 pedantic 也会增加改动；替代是保留默认 4 组（correctness/suspicious/complexity/perf/style）并本地用 `#[warn]` 加 restriction。

---

## 9. 下一步（建议）

现在采纳 **阶段 0 + 1**（经现有 seam 的 clippy，零新包），下个 sprint 做 **阶段 2 deny + osv-scanner**，**阶段 3 taplo/yamllint** 伺机而动，**阶段 4 统一 seam 仅在 agent 需要对非 LSP 诊断做响应式推送时**（否则 CI 门禁足够）。这镜像 LSP 诊断笔记的 A→B→C 演进——先做最小的推送。
