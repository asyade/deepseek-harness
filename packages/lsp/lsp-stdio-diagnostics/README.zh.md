---
description: "ctx.lspDiagnostics 的 stdio 诊断提供方：持久文档同步、推送（publishDiagnostics）+ 拉取（textDocument/diagnostic + workspace/diagnostic）混合、防抖合并/去重/截断——供组合本地诊断的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-stdio-diagnostics

[English](README.md) | 中文

## 概述

`dsh-lsp-stdio-diagnostics` 把配置好的本地语言服务器命令变成 `ctx.lspDiagnostics` 上的提供方：给它一张服务器命令与扩展名到语言映射的表，agent 就能获得由真实语言服务器支撑的工作区范围诊断——错误、警告与提示。一个插件实例为每个配置的服务器注册一个隔离的诊断提供方；每个提供方按工作区惰性启动一个服务器进程，并在该工作区存续期间保持文档打开（`didOpen`/`didChange`），以防抖合并、去重与截断提供推送+拉取混合（publishDiagnostics 加 `textDocument/diagnostic` 与 `workspace/diagnostic`）。服务器与源文件始终位于挂载的文件系统与子进程执行世界中。它是通用宿主，而非语言服务器目录或安装器——部署方显式配置命令。本包信任其配置的服务器，不附加自己的沙箱。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与推迟的工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当部署拥有本地语言服务器（例如 `typescript-language-server`）并希望 harness 通过它们呈现诊断时，挂载该提供方。它需要同一执行世界的文件系统与子进程提供方，外加 `dsh-lsp-diagnostics` seam；需要模型访问时再加 `dsh-tool-lsp-diagnostics`。

### 最小配置

`servers` 记录把每个稳定提供方 id 映射到一条服务器命令。提供方在加载时、凭据擦除后解析每个可执行文件，因此坏条目会阻止所有提供方注册；进程在首次工作区诊断查询时惰性启动。

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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `command` | 必填 | 要生成的进程——绝对路径，或在加载时按子进程 PATH 解析；无 shell 启动 |
| `extensionToLanguage` | 必填 | 小写点前缀扩展名 → LSP 语言 id（如 `{ '.ts': 'typescript' }`） |
| `args` | `[]` | 传给可执行文件的参数 |
| `env` | `{}` | 在凭据擦除的环境之上合并的额外环境；匹配 `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 的变量与所有 `DSH_*` 名称不转发 |
| `initializationOptions` | `null` | 转发给服务器的静态 `initialize` 选项 |
| `configuration` | `null` | 对每个 `workspace/configuration` 项的静态回答 |
| `maxMessageBytes` | `16000000` | 接受自服务器的最大单条成帧消息 |
| `maxStderrBytes` | `1000000` | 为诊断保留的最大 stderr 尾部 |
| `maxDocumentBytes` | `4000000` | 接受同步的最大源文档 |
| `shutdownTimeoutMs` | `5000` | 升级前的优雅 `shutdown`/`exit` 预算 |
| `killGraceMs` | `2000` | 请求取消与 SIGTERM→SIGKILL 升级宽限 |

`servers` 必须至少含一个非空 id 条目；定时器预算必须是 Node 定时器范围内的正整数，字节上限必须为正。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-lsp-stdio-diagnostics)是每个已接受字段的穷尽来源。

### Clippy 部署示例

<a id="clippy-deployment-examples"></a>

Clippy lint 走同一条 `ctx.lspDiagnostics` 推送流——无需新 seam。两个示例都产生 `LspDiagnostic{severity 1|2, code, message, range}`，采用提供方的防抖合并（`150 ms`）、去重（`JSON.stringify({ code, severity, message, source, range })`）与截断（每文件 `20` 条、`5` 个文件）。参见 [GOAT 研究](../../../docs/research/2026-08-31-goat-lint-diagnostics.zh.md#24-extended-cargo-clippy-diagnostic--is-it-relevant) 与 [LSP 子系统](../../../docs/subsystems/lsp.zh.md#clippy-via-lsp--deployment-example)。

**rust-analyzer clippy（小工作区推荐）：** 将 `rust-analyzer` 配置为在保存时运行 `cargo clippy`。在 `clippy.toml`（或 `Cargo.toml` 的 `[lints.clippy]`）中固定 `msrv` 并白名单 pedantic lint——绝不在 CI 中整体启用 `pedantic`/`nursery`/`restriction`。

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

CI 门禁（条件式）：`cargo clippy --all-targets --all-features -- -D warnings`。

**bacon-ls cargo 后端（大工作区的 GOAT）：** `bacon` + `bacon-ls` 在每次保存/打开/关闭时运行 `cargo clippy --message-format=json-diagnostic-rendered-ansi`，并每 `refreshIntervalSeconds:5` 流式发布 `publishDiagnostics`。需要禁用 `rust-analyzer` 诊断以避免重复发布：

```yaml
- name: '@deepseek-ai/dsh-lsp-stdio-diagnostics'
  config:
    servers:
      bacon-ls:
        command: bacon-ls
        extensionToLanguage: { '.rs': rust }
        initializationOptions: { updateOnSave: true, updateOnChange: true, refreshIntervalSeconds: 5 }
```

每个 `workspaceRoot` 选其一——`rust-analyzer` 与 `bacon-ls` 会竞争 `publishDiagnostics`。

### 查询做什么

对工作区的首次拉取时，提供方为该工作区启动一个服务器进程并保持池化。文档在存续期内持久打开（`didOpen` 一次，之后编辑时 `didChange`），因此服务器可以推送 `publishDiagnostics` 并回答 `textDocument/diagnostic` 与 `workspace/diagnostic`，无需按查询瞬态 open/close。推送快照在交付前防抖、合并、去重（按 `client.ts:91-105` 的 `JSON.stringify({ code, severity, message, source, range })`）并截断（每文件 20 条、5 个文件）；拉取路径返回同一合并快照。对同一服务器与工作区的查询串行化；不同工作区并行运行。池化进程在拉取期间失败时，提供方在新进程上重试一次。

### 可观察的成功与失败

成功快照携带 `byFile`（文件 → 诊断）、`workspaceRoot` 与 `at` 时间戳；空映射表示无诊断。源文件缺失、非普通文件、非 UTF-8、过大或在规范工作区之外（服务器启动前拒绝）时拉取失败；服务器返回畸形载荷时同样失败。被强杀的 harness 会留下服务器直到它们自行退出——优雅关闭只发生在服务释放时。

### 安全边界

该提供方信任其配置的服务器，不附加沙箱限制；服务器获得挂载执行世界的文件系统与进程权限。它在服务器启动前拒绝缺失、非普通、非 UTF-8、过大或规范上位于工作区之外的查询源。为同一执行世界挂载文件系统与子进程提供方——分离世界的组合无效。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释提供方背后的设计决策及代码实现位置；可观察行为见[使用本包](#use-this-package)。

### 设计理念

- **通用宿主，而非目录。** 部署方显式配置命令与映射；预设属于 `cordis.yml` 覆盖层，不属于本包。
- **持久同步，而非瞬态打开。** 每个工作区实例保持文档打开（`didOpen`/`didChange`），使推送与拉取共享状态；无按查询的 open/close 循环。
- **推送+拉取混合。** 实例把 `publishDiagnostics` 推送与 `textDocument/diagnostic`、`workspace/diagnostic` 拉取合并，然后统一去重与截断——消费方无论来自哪条路径都看到一个防抖快照。
- **每个规范工作区一个池化进程。** 实例按 `(server id, 规范工作区目标)` single-flight；传输失败在等待释放后于新进程上重试一次拉取。
- **按工作区串行化。** 每个工作区一个可中止队列串行化源读取/同步/查询生命周期；不同工作区并行运行；无法停止服务器的取消只终止该实例。
- **有界拆除。** 优雅 `shutdown`/`exit` 升级到进程树终止（POSIX 上进程组信号、Windows 上 `taskkill /T /F`）；静默以等待进程树退出确认，而非以 kill 结果为准。
- **执行世界配对。** 服务器经 `ctx.subprocess` 以 `processId: null` 启动，源文件经 `ctx.fs` 读取，不发出 `fs/observed` 事件——只有诊断快照对模型可见。

### 源文件映射

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、可执行文件解析、诊断提供方注册、工作区池化 |
| [`src/host.ts`](src/host.ts) | 经 `ctx.fs` 的工作区规范化与有界源读取 |
| [`src/instance.ts`](src/instance.ts) | 一个服务器进程：初始化、持久文档同步、混合拉取/推送、合并/去重/截断 |
| [`src/connection.ts`](src/connection.ts) | JSON-RPC 端点：id 关联、出站请求、入站服务器请求、stderr 上限 |
| [`src/framing.ts`](src/framing.ts) | `Content-Length` 成帧与有界解码器 |
| [`src/protocol.ts`](src/protocol.ts) | 线上类型子集：诊断、能力、publish/pull 的 raft |
| [`src/translate.ts`](src/translate.ts) | 位置编码协商、诊断规范化、`dedupeDiagnostics`/`capSnapshotFiles` |
| [`src/abort.ts`](src/abort.ts) | 融合调用方与释放信号的取消助手 |
| — | 不发布运行时不变式伴生入口；池与队列是私有状态，唯一可观察的约定是防抖快照及其 `lsp/diagnostics` 投影。 |

### 协议行为

初始化宣告 UTF-16 位置、工作区文件夹与配置、诊断能力（拉取与工作区）；服务器返回的能力具有权威性。服务器省略 `positionEncoding` 时默认为 `utf-16`。客户端以静态配置回答 `workspace/configuration`，接受生命周期簿记请求，并在 `JSON.stringify({ code, severity, message, source, range })` 去重与 `MAX_PER_FILE=20` / `MAX_FILES_PER_SNAPSHOT=5` 截断前合并 `publishDiagnostics` 推送与 `textDocument/diagnostic`、`workspace/diagnostic` 拉取。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。它们从共享诊断模型走向 seam、工具与决策依据。

- [LSP 导航子系统](../../../docs/subsystems/lsp.zh.md) —— 诊断 seam、快照、推送观察与 `LspError` 错误码。
- [dsh-lsp-diagnostics](../lsp-diagnostics/README.zh.md) —— 该提供方注册所依赖的 seam。
- [dsh-tool-lsp-diagnostics](../tool-lsp-diagnostics/README.zh.md) —— seam 之上的模型面向工具。
- [lsp 组映射](../README.zh.md) —— 六包家族及其相关文档。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-lsp-diagnostics`——它呈现该提供方的合并快照，而本宿主自身不贡献提示词或 schema。

#### KV Cache 效应

无直接失效；`dsh-tool-lsp-diagnostics` 拥有请求前缀变更。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了提供方不适用或需要特别运维的情形。它们是当前包约束，而非任务积压。

- **无限制策略** —— 本包信任配置的服务器，不沙箱其进程；受限部署必须提供合适的进程与文件系统提供方或同世界沙箱包装。
- **持久同步内存成本** —— 文档按工作区保持打开直到释放；长生命周期工作区进程消耗内存直到 harness 释放提供方。
- **按工作区串行化延迟** —— 并行 agent 共享一个服务器与工作区队列，排在单一进程之后；不同工作区并行运行。
- **被强杀的 harness 会孤儿化语言服务器** —— `initialize.processId: null` 移除了服务端客户端 PID 监控，因此服务器只靠优雅服务释放清理；SIGKILL 的 harness 会让它们运行到自行退出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
