---
description: "诊断能力 seam（ctx.lspDiagnostics）：面向工作区范围的快照查询、推送观察，以及以品牌化 id 为键的提供方注册表——供组合诊断的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-diagnostics

[English](README.md) | 中文

## 概述

`dsh-lsp-diagnostics` 提供 harness 的诊断 seam：agent 可以拉取当前工作区的诊断快照或订阅防抖后的推送快照；诊断服务（`ctx.lspDiagnostics`）把每个查询路由到已注册的诊断提供方。提供方以品牌化 id 注册，并按规范化的工作区根选择，因此更换提供方绝不会改变诊断的请求方式或模型所见。该服务只暴露类型化快照与推送订阅——无 JSON-RPC 逃生口、无文档或进程控制、无按扩展名的映射——且自身不贡献任何提示词或工具 schema——面向模型的 `lsp-diagnostics` 工具位于 `dsh-tool-lsp-diagnostics`。将其与 `dsh-lsp-stdio-diagnostics` 等提供方及工具组合，即可为 agent 提供拉取式诊断；本包单独存在时不做任何事。

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

挂载一个诊断提供方与 `lsp-diagnostics` 工具，让 agent 在写入后获得有界、按严重级别过滤的工作区错误视图——无需重读文件来重新发现它们。本包是这些包注册所依赖的服务；它自身不定义 UI、工具或提供方。

### 何时选用

当部署希望获得由语言服务器支撑的模型可见诊断时，选择该服务。它涵盖工作区范围的快照与防抖后的推送观察——为工作区拉取新鲜快照（可选收窄到单文件），或订阅全量快照推送。它刻意省略导航、变更与协议面；选择依据是规范化的 `workspaceRoot`，而非文件扩展名。

### 组合诊断栈

seam 需要提供方与消费方才有所作为。最小组合挂载服务、stdio 诊断提供方与工具：

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

服务器命令、扩展映射与文件系统/子进程配对在提供方包中配置；参见 [dsh-lsp-stdio-diagnostics](../lsp-stdio-diagnostics/README.zh.md) 与 [dsh-tool-lsp-diagnostics](../tool-lsp-diagnostics/README.zh.md)。

### 快照与推送

快照（`LspDiagnosticsSnapshot`）按文件分组诊断（`byFile: ReadonlyMap<string, readonly LspDiagnostic[]>`），并携带 `workspaceRoot` 与 `at`（单调递增的提交时间戳）。请求（`LspDiagnosticsRequest`）提供 `workspaceRoot` 与可选的 `filePath`；seam 规范化 `workspaceRoot`（trim + 尾部分隔符规范化，`src/index.ts:canonicalizeWorkspaceRoot`）并委派给提供方。seam 还通过 `onDiagnostics` 转发防抖后的全量快照推送；提供方合并快速变化，工具只走拉取路径。

### 失败与恢复

未注册提供方时查询以 `LSP_UNAVAILABLE` 失败；`workspaceRoot` 经 trim 后为空时以 `LSP_INVALID_PROVIDER` 失败。无效或冲突的提供方注册在任何路由发布前以 `LSP_INVALID_PROVIDER` 或 `LSP_CONFLICT` 失败。消费方捕获 `LspError` 并按其稳定 `code` 路由；经工具这些会呈现为模型可读的错误结果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释 seam 背后的设计决策及代码实现位置；可观察行为见[使用本包](#use-this-package)。

### 设计理念

- **能力 seam，Service Definition 角色。** 本包拥有 `ctx.lspDiagnostics` 与提供方注册表；提供方注册的是能力而非工具，`dsh-tool-lsp-diagnostics` 是面向模型表面的唯一 owner。
- **原子化注册。** `registerProvider()` 在变更前校验与冲突检查：无效或冲突的注册不发布任何内容，其 disposer 一并释放 id 与推送转发。v1 允许单一全局提供方；第二次注册即冲突。
- **工作区范围选择。** `diagnostics()` 在无 `ctx.fs` 的情况下同步规范化 `workspaceRoot`（trim 与尾部分隔符规范化，镜像 `packages/lsp/lsp-stdio/src/host.ts:32-59`）并委派给唯一提供方；不存在按扩展名的映射。
- **封闭快照词汇。** 诊断记录、快照与提供方契约位于 `src/types.ts`；位置与 range 为基于零的 UTF-16。去重镜像 opencode `client.ts:91-105`（`JSON.stringify({ code, severity, message, source, range })`），截断（`MAX_PER_FILE=20`、跨文件 5）由提供方强制，但消费方应把结果视为已截断。
- **无协议逃生口。** seam 不暴露文档或进程控制，也无通用 JSON-RPC 面——只有类型化快照与推送订阅。

### 源文件映射

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`LspDiagnostics` 服务、`registerProvider`/`diagnostics`/`onDiagnostics`、`canonicalizeWorkspaceRoot`、`LspError` |
| [`src/types.ts`](src/types.ts) | seam 词汇：`LspDiagnostic`、`LspDiagnosticsSnapshot`、`LspDiagnosticsRequest`、提供方与服务契约 |
| [`src/brand.ts`](src/brand.ts) | `LspDiagnosticsProviderId` 品牌化 id 类型与工厂 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生（无运行时不变量；提供方与推送订阅为私有原子状态） |

### 注册与生命周期

注册与释放经 `ctx.effect()` 运行，因此提供方路由与推送转发随注册 fiber 同生共死。`canonicalizeWorkspaceRoot()` 执行 trim 并去除尾部分隔符，空输入以 `LSP_INVALID_PROVIDER` 拒绝。`LspError` 扩展 `HarnessError`，提供稳定错误码（`LSP_INVALID_PROVIDER`、`LSP_CONFLICT`、`LSP_UNAVAILABLE`），调用方按其路由而非解析 `message`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。它们从共享诊断模型走向提供方、工具与决策依据。

- [LSP 导航子系统](../../../docs/subsystems/lsp.zh.md) —— 诊断 seam、快照、推送观察与 `LspError` 错误码。
- [dsh-lsp-stdio-diagnostics](../lsp-stdio-diagnostics/README.zh.md) —— 注册到该 seam 的 stdio 提供方。
- [dsh-tool-lsp-diagnostics](../tool-lsp-diagnostics/README.zh.md) —— 该 seam 之上的模型面向工具。
- [lsp 组映射](../README.zh.md) —— 六包家族及其相关文档。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-lsp-diagnostics`——它拥有面向模型的 `lsp-diagnostics` schema、提示词指引与渲染结果，而本注册表自身不贡献提示词或 schema。

#### KV Cache 效应

无直接失效；`dsh-tool-lsp-diagnostics` 拥有请求前缀变更。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了 seam 当前的范围。它们是包约束，而非任务积压。

- **单一全局提供方（v1）** —— 每个 harness 只能注册一个诊断提供方；选择不按工作区或扩展名，因此第二个提供方即使 id 不同也会冲突。按工作区路由是预期的扩展。
- **无按扩展名映射** —— 与 `ctx.lsp` 不同，诊断选择按工作区范围；扩展名到语言的映射位于 stdio 提供方，用于驱动 `didOpen`/`didChange` 语言 id，而非 seam。
- **截断由提供方强制** —— seam 不强制 `MAX_PER_FILE=20` 或跨文件 5；由提供方执行，消费方必须把快照视为已截断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
