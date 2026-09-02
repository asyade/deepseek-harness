---
description: "面向模型的 lsp-diagnostics 工具：一次只读快照拉取，5 文件 × 每文件 20 条截断、默认 severity 1、有界渲染——供组合诊断的用户与维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-lsp-diagnostics

[English](README.md) | 中文

## 概述

`dsh-tool-lsp-diagnostics` 给模型提供一个只读的 `lsp-diagnostics` 工具，用于拉取当前工作区的诊断快照。该工具拥有模型所见的一切——名称、schema、提示词指引、结果格式化与 UI 呈现——且绝不依赖于哪个语言服务器支撑查询。默认只显示错误（severity 1），截断为 5 文件 × 每文件 20 条并限制在 16 000 字符以内，带显式省略与截断标记。将其与 `dsh-lsp-stdio-diagnostics` 等提供方及 `dsh-lsp-diagnostics` seam 组合以呈现诊断；在写入后调用它来检查编译错误，无需重新发现它们。

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

agent 在写入文件后使用 `lsp-diagnostics` 拉取防抖后的诊断快照——而非实时推送流——并决定是修复、解释还是继续。工具的提示词指引告诉它在写入后优先使用该拉取，并在检查单文件时用 `file_path` 过滤。

### 工具

`lsp-diagnostics` 接受可选 `file_path`（相对于工作区或绝对路径；缺省时返回截断为 5 文件的工作区快照）。工作区根来自会话 `header.cwd`，绝不可由模型配置。提供方选择、限制、超时与可执行文件都在模型输入之外。

### 模型得到什么

诊断渲染为 `<diagnostics file="...">` 块，每文件一个，每块列出 `SEVERITY [line:col] message` 行（对模型为基于 1 的 UTF-16；排序与去重已由提供方完成）。结果默认过滤到 severity 1（Error），先按 `maxPerFile`（20）截断，再按 `maxFiles`（5），最后按 `maxResultChars`（16 000）截断，省略与截断标记包含在完整截断之内。空快照为成功的 `No diagnostics.` 响应。

### 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxFiles` | `5` | 出现省略标记前结果中最大的文件数（`write.ts:18`） |
| `maxPerFile` | `20` | 出现 `... and N more` 前每文件最大的诊断数（`diagnostic.ts:1`） |
| `maxResultChars` | `16000` | 最大的完整渲染结果，含截断元数据 |
| `timeoutMs` | `10000` | 由 `dsh-tool-call-timeout-policy` 强制的工具调用超时预算；覆盖快照拉取，不可由模型配置 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-lsp-diagnostics)是每个已接受字段的穷尽来源。

### 失败与恢复

工具要求会话工作区根（`header.cwd`），无回退；缺失在任何查询前以 `LSP_WORKSPACE_REQUIRED` 失败。未注册提供方时拉取以 `LSP_UNAVAILABLE` 失败；畸形提供方载荷保持为结构化 `LSP_MALFORMED_RESPONSE` 错误。这些以模型可读可路由的错误工具结果呈现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释工具背后的设计决策及代码实现位置；可观察行为见[使用本包](#use-this-package)。

### 设计说明

- **仅消费方。** 工具运行时只注入 `tools`、`lspDiagnostics` 与 `systemPrompt`，不导入任何提供方，只把 `exec.signal` 传给 seam。
- **来自会话的工作区根。** `sessionCwd(exec)` 从 `header.cwd` 推导 `workspaceRoot`；缺失时抛 `LSP_WORKSPACE_REQUIRED`。
- **严重级别过滤与截断。** 执行把快照诊断过滤到 severity 1（`d.severity ?? 1 === 1`），再用 `maxPerFile` 按文件截断、`maxFiles` 跨文件截断；渲染最后按 `maxResultChars` 截断，镜像 opencode `diagnostic.ts` 与 `write.ts:18`。
- **规范结果透传。** 工具返回 `{ kind: 'diagnostics', diagnostics: [{ file, diagnostics: LspDiagnostic[] }] }`，原生渲染器可直接检查每个文件桶与基于零的 range。
- **有界渲染。** `formatDiagnostics` 拼接每文件的 `report()` 块（`<diagnostics file="...">`），在 16 000 截断内应用省略（`… N more files omitted`）与截断（`… diagnostics truncated`）标记，空或按严重级别过滤后为空时返回 `No diagnostics.`。
- **通用搜索卡呈现。** `presentDiagnosticsCall` 渲染 `{ card: 'generic', kind: 'search', title, locations: [{ path, line }] }` 视图；标题携带 `LSP diagnostics workspace` 或 `LSP diagnostics <file_path>`。

### 源文件映射

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、工具注册、系统提示词小节、执行与严重级别/截断逻辑 |
| [`src/render.ts`](src/render.ts) | 纯格式化：`prettyDiagnostic`/`report`/`formatDiagnostics`、截断、UI 呈现 |
| [`src/session-cwd.ts`](src/session-cwd.ts) | 来自会话 `header.cwd` 的工作区根 |
| — | 不发布运行时不变式伴生入口；这个无状态适配器只贡献一个工具与提示词段落，快照生命周期由它组合的 diagnostics seam 拥有。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够时阅读这些页面。它们从模型面向表面走向 seam、提供方与决策依据。

- [LSP 导航子系统](../../../docs/subsystems/lsp.zh.md) —— 诊断 seam、快照、推送观察与 `LspError` 错误码。
- [dsh-lsp-diagnostics](../lsp-diagnostics/README.zh.md) —— 该工具查询的 seam。
- [dsh-lsp-stdio-diagnostics](../lsp-stdio-diagnostics/README.zh.md) —— 回答这些查询的 stdio 提供方。
- [lsp 组映射](../README.zh.md) —— 六包家族及其相关文档。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型所见

一个系统提示词小节（第一方顺序 2200）把诊断定位为拉取快照，文本如下：

##### 逐字指引

```markdown
Use lsp-diagnostics to pull the current diagnostics snapshot after writes. It returns the debounced snapshot (errors only by default, 5 files×20 per file, capped) — not a live push stream. Filter with file_path for one file; omit for workspace.
```

#### Token 效应

插件激活时每次请求都有固定指引开销。

#### KV Cache 效应

插件 scope 与指引文本不变时前缀稳定；激活或释放可能使本小节的复用失效。

### 工具 schema

#### 模型所见

模型看到生成的 [`lsp-diagnostics` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-lsp-diagnostics)。

#### Token 效应

启用时每次请求都有固定 schema 开销；`timeoutMs` 预算从不发给模型。

#### KV Cache 效应

可见工具定义与顺序不变时前缀稳定；注册生命周期或 scope 限制可能使自第一个变更 schema token 起的复用失效。

### 结果

#### 模型所见

`<diagnostics file="...">` 块，含 `SEVERITY [line:col] message` 行，过滤到 severity 1，先按 `maxPerFile`（20）截断，再按 `maxFiles`（5），最后按 `maxResultChars`（16 000）；省略与截断标记包含在完整截断之内。空快照使用独立的 `No diagnostics.` 行。

#### Token 效应

按 `maxResultChars` 截断每个工具结果，`maxFiles` 与 `maxPerFile` 额外约束条目数。

#### KV Cache 效应

工具结果追加在缓存的请求前缀之后，不直接使其失效。

### UI 呈现

#### 模型所见

无。客户端渲染通用搜索卡——`{ card: 'generic', kind: 'search', title, locations: [{ path, line }] }`——其标题携带 `LSP diagnostics workspace` 或 `LSP diagnostics <file_path>`。

#### Token 效应

零直接 token 效应，因为渲染只在客户端。

#### KV Cache 效应

无；UI 呈现在模型请求之外。

## 已知限制与推迟的工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了工具不适用的情形。它们是当前包约束，而非任务积压。

- **仅错误默认** —— 工具默认只显示 severity 1 诊断；警告、信息与提示在呈现前被过滤以保持快照精简。
- **截断快照呈现** —— 5 文件 × 每文件 20 条加 16 000 字符约束模型所见；完整快照保留在 seam 中供原生消费方使用。
- **无实时推送流** —— 工具只拉取；`onDiagnostics` 推送由提供方与 seam 内部消费，不流式化为工具结果。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
