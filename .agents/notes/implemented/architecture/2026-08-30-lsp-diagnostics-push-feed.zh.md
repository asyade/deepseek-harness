# Agent Note: LSP 诊断推送流（完整同步 + 会话事件 + 拉取工具）

Status: implemented

[English](2026-08-30-lsp-diagnostics-push-feed.md) | 中文

## 问题

当前 harness 的精确导航（`goToDefinition`/`findReferences`/`goToImplementation`/`hover`）已通过瞬态打开的 seam 实现（`packages/lsp/lsp` + `packages/lsp/lsp-stdio` + `packages/lsp/tool-lsp`），但缺少诊断能力。[2026-07-15-lsp-capability-seam.md](../../implemented/architecture/2026-07-15-lsp-capability-seam.zh.md) 第 144 行刻意推迟的——“Diagnostics need separate freshness, accumulation, and transcript rules”——正是当前缺口。

本决策的对比研究基础：

- **DSH 现状**：封闭的 4 操作词汇（`packages/lsp/lsp/src/types.ts` 的 `goToDefinition` 等），`packages/lsp/lsp/src/index.ts:18-25` 的三包 seam，基于 branded `LspProviderId` + `extensionToLanguage` 的提供方注册，`packages/lsp/lsp-stdio/src/instance.ts` 的瞬态打开（didOpen version 1 → 请求 → didClose），`packages/lsp/lsp-stdio/src/connection.ts:254` 丢弃 server→client 通知，无 `publishDiagnostics`，无 observation API，无 `textDocument/diagnostic` 拉取。`@deepseek-ai/dsh-lsp-stdio` 为通用宿主，部署方显式配置命令与映射。
- **Opencode 深度审计**（克隆于 `/tmp/opencode`，依据 `https://opencode.ai/docs/agents/`、`https://opencode.ai/docs/tools/`、`https://opencode.ai/docs/plugins/`、`https://opencode.ai/docs/server/`、`https://opencode.ai/docs/custom-tools/`）：**无专用诊断推送流**。证据：`%70ackages/opencode/src/lsp/client.ts:139-172` 的私有 `pushDiagnostics`/`pullDiagnostics` + `diagnosticListeners` 仅用于 `waitForFreshPush` 的 150ms 防抖；`packages/schema/src/lsp-event.ts:5` 的 `lsp.updated` 仅在新建 LSP 客户端时触发且 schema 为 `{}`（`%70ackages/opencode/src/lsp/lsp.ts:293`）；`packages/schema/src/event-manifest.ts` 无 `diagnostic` 事件；`packages/plugin/src/index.ts:222-335` 的 `Hooks` 无 `lsp.*`/`diagnostic` 钩子——只有通用 `event` 与观察 `metadata.diagnostics` 的 `tool.execute.after`。诊断是**写后拉取**：`%70ackages/opencode/src/tool/write.ts:74-90`、`edit.ts:197-201`、`apply_patch.ts:265-292` 执行 `yield* lsp.touchFile(file,"document"); const diagnostics = yield* lsp.diagnostics()`，再由 `%70ackages/opencode/src/lsp/diagnostic.ts:5-27` 仅格式化 `severity===1`（Error）且每文件最多 20 条，以 `<diagnostics file="...">` 文本嵌入工具输出 + `tool.return.metadata.diagnostics`。不存在 `publishDiagnostics` 事件总线、`diagnostic` SDK 流、插件订阅或 agent 响应式中断；agent 只能在同一轮的 `tool` 结果中看到诊断。
- **Opencode 同步**：持久模型（`%70ackages/opencode/src/lsp/client.ts:554-622` 的 `notify.open` 与 `files: Record<string,{version,text}>`，首开 `didOpen` 后续 `didChange`，版本递增，永不 `didClose`，`workspace/didChangeWatchedFiles` + `textDocument/didChange` 的 `TEXT_DOCUMENT_SYNC_INCREMENTAL` 差异同步），DSH 为瞬态（每查询 open/close）。等待策略：`DIAGNOSTICS_DEBOUNCE_MS=150`、`DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS=5_000`、`DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS=10_000`、`DIAGNOSTICS_REQUEST_TIMEOUT_MS=3_000`（`client.ts:13-16`），混合推送（`publishDiagnostics` 防抖）+ 拉取（跨标识符并行 `textDocument/diagnostic` + `workspace/diagnostic`）+ 动态 `diagnosticProvider` 的 `waitForRegistrationChange`（`client.ts:272-541`）。公开面：`touchFile(path, "document"|"full")` + `diagnostics()` + `waitForDiagnostics()`（`client.ts:623-643`、`lsp.ts:344-375`）。调试 CLI `lsp diagnostics <file>` 执行 `touchFile+diagnostics`（`%70ackages/opencode/src/cli/cmd/debug/lsp.ts:16-23`）。
- **DSH 优势**：MemOS/chakal 卡片、分层 ACP 压缩（`packages/acp`）、`workflow`/`ralph`/`goals`（`packages/goal`）、可持续子代理、branded id、`session/event` 持久总线、`ctx.fs`+`ctx.subprocess` 同执行世界配对。依据对 `/home/acorbeau/Repos/deepseek-harness` 的 `grep`（发现 `docs/user/guide/mcp-memory.md` 的 `dsh-mcp-client`、`python/sdk/` 的 python SDK）。
- **理念差异**：DSH 是平台（Cordis seams Service/Provider/Consumer、模型可见⟺已记录需会话事件、插件不改循环、branded id、fail-loud、100% 覆盖率门禁、设计笔记 `.agents/notes/implemented/`、EN+ZH 文档），Opencode 是产品（Bun/TS、`opencode.json` + `.opencode/{plugins,tools,agents}`、事件钩子 `tool.execute.before/after`、`session.idle`、`lsp.client.diagnostics`、按项目的自定义工具、MCP server+client、headless 运行、会话树）。本决策遵守 DSH 约束：无 JSON-RPC 逃生口、模型不选 provider/languageId/workspaceRoot、`query(request,signal?)` 原子化、`ctx.effect()` 注册、顺序无关选择。

目标演化：用户已在 A（仅拉取工具）/ B（拉取 + 类型化推送事件）中选择 **C（完整推送：持久 didOpen/didChange 同步 + 会话事件 + 循环注入）**。双仓深挖以新证据（opencode 无推送先例）重估 A/B/C 并确认 C；以下 seam/同步/事件与工作流设计即为已交付内容。

## 决策

新增**完整的 LSP 诊断能力**，精神上对齐 opencode 但以 DSH 原生的推送流实现。已交付的 MVP 为观察 seam + 持久同步 + 类型化会话事件；循环注入/中断策略仍为消费该观察的后续。单次仓库工作流交付（设计笔记 EN+ZH、100% 覆盖率、lint/typecheck、doc-sync 重生成目录、chakal 卡片更新）。

### 1. 新 seam：`@deepseek-ai/dsh-lsp-diagnostics`

**不**扩展 `ctx.lsp` 的 4 操作封闭词汇（`packages/lsp/lsp/src/types.ts:18`）——加入诊断会违反封闭联合契约，并将导航的 `LspOperation` 与推迟笔记刻意分离的新鲜度/累积/转录问题耦合。不复用路由表——诊断是按工作区维度的流，而非按扩展名选择。

`@deepseek-ai/dsh-lsp-diagnostics` 位于 `packages/lsp/lsp-diagnostics`，拥有 `ctx.lspDiagnostics`：

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

- Brand `LspDiagnosticsProviderId`，像 `packages/lsp/lsp/src/index.ts:34-90` 那样原子化预留/释放——无效或冲突的注册不发布任何内容。
- 选择：诊断按工作区维度而非扩展名；提供方由 `workspaceRoot` 规范化目标决定（复用 `packages/lsp/lsp-stdio/src/host.ts:32-59` 经 `ctx.fs` 的 `canonicalizeWorkspace`）。模型输入不参与提供方选择。
- 结果截断对齐 opencode 展示：`MAX_PER_FILE=20`（`%70ackages/opencode/src/lsp/diagnostic.ts:1`）、跨文件 5 个（`%70ackages/opencode/src/tool/write.ts:18` 的 `MAX_PROJECT_DIAGNOSTICS_FILES=5`）、`maxResultChars` 16_000 同 `packages/lsp/tool-lsp`——插件加载时可配置，模型永不设置。严重级别：默认只呈现 Error，Warn 可选（opencode 在 `diagnostic.ts:21` 静默丢弃 Warn；DSH 将其作为显式策略）。
- 去重同 `client.ts:91-105` 的 `JSON.stringify({code,severity,message,source,range})`。

### 2. 本地提供方：`@deepseek-ai/dsh-lsp-stdio-diagnostics`

**新 seam 插件** `packages/lsp/lsp-stdio-diagnostics` 像 `dsh-lsp-stdio` 一样组合 `ctx.fs` + `ctx.subprocess`，但拥有持久文档状态与诊断协议。（单包方案会把导航的瞬态打开与持久同步耦合，并使 `maxDocumentBytes` 归属模糊——作为 seam 违规拒绝。）

职责：

- 按 `(providerId, 规范化 workspace)` 惰性 single-flight 服务（同 `packages/lsp/lsp-stdio/src/instance.ts`），但**持久文档**：`Map<string,{version,text,languageId}>` 直到工作区释放或淘汰 `didClose` 才清除。实现 `didOpen`（首次 version 0）→ `didChange`（版本递增 + 按 `textDocumentSync` 类型选择增量/全量 `contentChanges`，同 opencode `client.ts:584-595`）→ 按 opencode 模型无 `didClose`，或 LRU 淘汰时有限 `didClose`。发送 `workspace/didChangeWatchedFiles`（同 `client.ts:568-606`，`FILE_CHANGE_CREATED=1`、`FILE_CHANGE_CHANGED=2`）。
- 协议：同时处理 **推送** `textDocument/publishDiagnostics`（`client.ts:160-172`）与 **拉取** `textDocument/diagnostic`/`workspace/diagnostic`（`client.ts:293-444`）。合并策略：`pushDiagnostics` + `pullDiagnostics` → `dedupeDiagnostics` → `mergedDiagnostics`，`published` 映射记录 `{at,version}` 以防抖。标识符：跨 `identifier` 变体并行扇出（`client.ts:412-414`），满足 `hasCurrentFileDiagnostics` 即早退，无 post-match settle 延迟（按 opencode `client.ts:412-415` 注释引用的 PR #23771）。
- 防抖/超时：沿用 opencode 调优为默认值——`DIAGNOSTICS_DEBOUNCE_MS=150`、`DOCUMENT_WAIT=5_000`、`FULL_WAIT=10_000`、`REQUEST_TIMEOUT=3_000`，插件配置可覆盖。`waitForFreshPush`（`client.ts:464-497`）含 `debounceTimer` + `timeoutTimer` + `diagnosticListeners` 集合；`waitForDocumentDiagnostics` 与 `waitForFullDiagnostics` 竞争推送/拉取/注册变化（`client.ts:499-541`）。经 `client/registerCapability`（`client.ts:180-198`）跟踪动态 `diagnosticProvider` 注册。
- 初始化：复用 `packages/lsp/lsp-stdio/src/protocol.ts` 握手，并精确添加 opencode `client.ts:230-258` 的诊断能力：`workspace.diagnostics.refreshSupport:false`、`textDocument.diagnostic.dynamicRegistration:true, relatedDocumentSupport:true`、`publishDiagnostics.versionSupport:false`。`processId:null`（不同命名空间）、`positionEncodings:['utf-16']`、`workspaceFolders` 规范化 URI。
- 文件系统配对：经 `ctx.fs` 读取/同步（`packages/lsp/lsp-stdio/src/host.ts:72-120` 的 `readHostSource`），经 `ctx.subprocess` 启动，同一执行世界。强制 `maxDocumentBytes`（4_000_000）、`maxMessageBytes`（16_000_000）、`maxStderrBytes`（1_000_000），同现有 stdio 宿主。**不**发送 `fs/observed`——诊断是派生数据而非模型观察；只有 `lspDiagnostics` 快照对模型可见。
- FS 观察联动：将 `ctx.fs.observe` / watcher 事件（或 `tool` 的 write/edit/apply_patch 成功）与 `didChange` 通知联动，使诊断无需模型工具调用即可保持新鲜。stdio 诊断提供方在内部订阅 `session/event` 或 fs watcher——**而非**经模型工具——来递增版本。这是 C 的“推送”半边：由写入驱动的持久同步，不止 `touchFile`。
- 连接处理：`packages/lsp/lsp-stdio/src/connection.ts:240-280` 原先丢弃 server→client 通知（`// ignored by this MVP host`）。现转发 `textDocument/publishDiagnostics` 到诊断存储，并按 `client.ts:173-206` 处理 `workspace/diagnostic/refresh`、`client/registerCapability`、`workspace/configuration`、`window/workDoneProgress/create`。`connection.ts` 保持通用，为诊断提供方提供类型化钩子。

### 3. 会话事件与持久转录

DSH SessionEventMap 可合并扩展（`packages/core/session/src/types.ts`）。经声明合并扩展；`packages/core/session/src/types.ts` 中的已交付形状为：

```ts
import type { LspDiagnostic } from '@deepseek-ai/dsh-lsp-diagnostics'
interface SessionEventMap {
  'lsp/diagnostics': { workspaceRoot: string; byFile: Record<string, LspDiagnostic[]>; at: number }
}
```

- 诊断服务在防抖后的新鲜快照提交时（`waitForFreshPush` 或拉取合并后）执行 `session.append('lsp/diagnostics', data)`。经 `ctx.on('session/event', ...)`（`packages/core/session/src/index.ts:75-77`，提交后 fire-and-forget）实现模型可见⟺已记录：每个可见诊断都有持久事件，满足 DSH 不变量。与 opencode 私有 `pushDiagnostics` Map 不同，DSH 的 `byFile` 持久且可重放。
- 表面：诊断事件**非** `SurfaceEventType`（不像 `user/message`/`assistant/message`/`tool/result` 那样在 `packages/core/session/src/surface.ts` 产生 `deriveMessages` 历史），因此绕过 `deriveMessages` 折叠——它们是带外观察。projection 包 `session-projection` 可将其折叠为客户端载体使用的 `lspDiagnostics` 单元；遥测（`session-telemetry`）可采样。
- 累积：按工作区的快照替换先前的 `byFile`（全量替换，非增量补丁），带 `at` 时间戳。需要按文件差异的消费方可比较映射。
- 转录规则：默认**不**将诊断注入为合成 `assistant/message` 或 `tool/result` 块；它们是兄弟流，由 (a) `lsp-diagnostics` 拉取工具、(b) projection、(c) 可选 agent-loop 观察者消费——后者可在出现 severity 1 时 `session.append('assistant/message', ...)` 或中断，该策略属于 `agent-loop` 而非 seam。

### 4. 面向模型的工具：`lsp-diagnostics`（拉取）+ `lsp` 保持不变

- `packages/lsp/tool-lsp` 保持不变（仍为 4 操作 hover/definition）。`@deepseek-ai/dsh-tool-lsp-diagnostics` 位于 `packages/lsp/tool-lsp-diagnostics`，注册 `ctx.tools.register(defineTool({name:'lsp-diagnostics', parameters:{file_path?}, description:'Diagnostics feed...'}))`。
- 工具输入：`{ file_path?: string, workspace_root?: string }`，`file_path` 过滤到单文件（同 opencode `diagnostic.ts:report`），缺省返回截断快照（5 文件、每文件 20 条）。经 `z`/`schemastery` 校验，`workspaceRoot` 经 `sessionCwd(exec)` 助手（`packages/lsp/tool-lsp/src/session-cwd.ts`）从 `session.header.cwd` 解析。输出 schema：`{kind:'diagnostics', diagnostics: Array<{file, diagnostics: LspDiagnostic[]}> }` 或空成功。`MAX_TIMER_DELAY_MS` 守卫 + `timeoutMs` 默认 10_000（对齐 opencode FULL 等待；比 `tool-lsp` 的 60_000 更轻）。
- 提示词指引：`FIRST_PARTY_SECTION_ORDER.TOOL_LSP` 兄弟项：“Use lsp-diagnostics to check errors after writes; it pulls the debounced snapshot, not live push.”

### 5. 循环/观察者集成（C 的区分点）

- `packages/core/agent-loop` 或新 `lsp-diagnostics-loop-observer` 插件订阅 `type==='lsp/diagnostics'` 的 `session/event`，当活动工作区出现 `severity===1` 时可选地注入轮次触发。这是完整推送链：FS 写入 → `didChange` → `publishDiagnostics`/拉取 → `session.append('lsp/diagnostics')` → `session/event` → 循环观察者 → 无需模型轮询即可看到新上下文。策略：不自动重试失败的 tool 调用；像 opencode `write.ts:85` 那样作为 `tool/result` 元数据呈现，同时作为会话事件让**下一轮** LLM 无需冗余 `lsp-diagnostics` 调用即可响应。
- 背压：追加的快照截断为 5 文件/每文件 20 条，除非配置启用否则丢弃 Warn/Info/Hint，150ms 防抖，并将快速 `didChange` 突发合并为单一快照。循环观察者本身为**推迟的后续**；已交付 MVP 是观察 seam、持久同步、会话事件与拉取工具。

## 已考虑的替代方案

**A. 仅拉取工具（瞬态打开 `lsp-diagnostics` 查询）**：最小改动——添加 `textDocument/diagnostic` 拉取，无持久同步与会话事件。工具瞬态打开（`didOpen` v1 → `textDocument/diagnostic` → `didClose`）并返回过滤后的诊断。优点：无持久状态、无 FS watcher、无会话事件刷屏、符合 DSH 现有瞬态打开契约、测试成本最低。缺点：无推送流（用户要求推送）、查询间 stale、无法承载长驻服务器的后台 `workspace/diagnostic` 或 `publishDiagnostics`、每查询重复解析（延迟）、无可重放/投影的持久累积。opencode 审计显示仅拉取会比 opencode *更弱*（opencode 已有持久同步 + 混合等待）。评级：**未采纳**——解决“写后检查”但不解决“无需重问 agent 即可响应”。

**B. 拉取 + 类型化推送事件（防抖会话事件，但同步仍瞬态）**：工具经 `textDocument/diagnostic` 拉取；提供方同时订阅 `publishDiagnostics` 并追加 `lsp/diagnostics` 事件，但仍按拉取瞬态 open/close（无 `didChange` 镜像）。优点：无需持久文档状态机即可获得持久观察与投影；会话转录获得新鲜度。缺点：瞬态 `didClose` 可能在推送到达前清掉服务端状态而漏掉 `publishDiagnostics`；clangd 怪癖（`client.ts:564` 的“Do not wipe diagnostics on didChange”）未处理；仍抖动 `didOpen`/`didClose` 且无法利用增量同步。评级：若 C 风险不可接受则为 **sweet spot**，但用户已选 C。

**C. 完整推送（持久同步 + 会话事件 + 循环注入）——已选**。优点：复刻 opencode 已验证的持久模型（`client.ts:268` 的 `files` 映射、版本递增、不关闭）、正确处理 `publishDiagnostics` + 拉取混合、首开后每查询延迟最低、完整支持工作区级 `workspace/diagnostic`、防抖 + 注册跟踪已获验证、持久的 `lsp/diagnostics` 支持重放/投影/遥测、循环观察者无需模型轮询即可注入轮次。缺点：新状态机（持久文档、版本归属、全路径 `didChange`、LRU 淘汰、HMR 恢复、stale 状态规则——即 2026-07-15 笔记标记的推迟复杂度）、FS watcher 耦合、每文件诊断都追加则转录噪声、像 opencode 永不关闭那样内存增长除非有界。需要有限的 `didClose`/淘汰。结论：**已选**，因用户明确要求推送流，且 opencode 审计证明推送信号必须自建（无先例可抄），故 DSH 构建完整同步。

**落位替代**：

- 扩展 `packages/lsp/lsp`（向 `LspOperation` 添加 `diagnostics`）：拒绝——违反封闭 4 操作词汇、混淆导航与诊断的新鲜度/转录规则、破坏 `assertNever` 穷尽性、迫使所有提供方实现诊断。
- 新 seam `dsh-lsp-diagnostics`（已选）：采纳——诊断有不同新鲜度（防抖）、累积（byFile 快照）与转录（非 `deriveMessages`）规则；独立 `ctx.lspDiagnostics` 使关注点对齐推迟笔记的边界。
- 复用 `routes`（fs 或 agent-loop）：拒绝——耦合 seam；诊断需要 LSP 协议，而非通用 FS 或循环观察者。

**协议替代**：

- 仅 `publishDiagnostics` 推送（无拉取）：拒绝——`rust-analyzer` 等服务按 `client.ts:258` 的 `hasStaticPullDiagnostics` 需要拉取（`textDocument/diagnostic`）；opencode 合并两者。
- 仅拉取（无推送）：拒绝——丢失 TS/clangd 主动推送的 `publishDiagnostics`。
- 将 opencode 内部 `diagnosticListeners` Set 暴露为插件钩子：拒绝——DSH 需要类型化 `SessionEvent`，而非 Cordis 事件总线；`tool.execute.after` 元数据是插件相邻路径，不是诊断总线。

## 后果

- 模型可在写入后经 `lsp-diagnostics {file_path}` 拉取（同 opencode `write.ts:85` 反馈），也可无需轮询地后台观察 `lsp/diagnostics` 事件。
- 工作区进程保持温热；按工作区 single-flight 仍串行化查询生命周期，但文档不再抖动 `didOpen`/`didClose`。
- 会话日志获得可重放的诊断流，供重放、投影与遥测使用；compaction 像处理其他非 surface 事件一样遮蔽它。
- 导航 seam 的扩展名排他性保持不变，诊断按工作区正交，无冲突。
- **状态机风险**：持久文档引入版本归属、增量同步类型（`Full`/`Incremental`/`openClose:true`）、`didSave`（服务端可能期望）、LRU 淘汰与无操作写入后的 stale 诊断（opencode 在 `client.ts:564` 为 clangd 保留；DSH 保留而非清除）。以复刻 opencode 的 `shouldSeedDiagnosticsOnFirstPush` TS 特例与“didChange 不清除”规则缓解。
- **转录噪声**：每次文件写入都可能追加 `lsp/diagnostics` 事件；无截断（5 文件/每文件 20 条/severity 1）日志会泛滥。以快照替换 + 防抖 + 严重级别过滤缓解。
- **内存**：opencode 永不关闭的模型会泄漏；以 `maxOpenDocuments` LRU + 淘汰 `didClose` 或绑定工作区释放来限制。
- **能力探测**：`diagnosticProvider` 可为静态（`initialize`）或动态（`client/registerCapability`）；缺一即空拉取。镜像 `client.ts:270-377` 的 `hasStaticPullDiagnostics` + `diagnosticRegistrations` 跟踪与 `workspace/diagnostic/refresh` 空操作。
- **文件系统/执行世界漂移**：`ctx.fs` 路径与子进程 cwd 须同命名空间，否则 `file:` URI 与 `rootUri` 分歧。以 `canonicalizeWorkspace` + `contains` 检查守卫（同 `host.ts:91-93`）。
- **测试成本**：DSH 的 100% 覆盖率门禁 + fake-stdio + 真实 TS e2e（无 key 的固定服务器）须覆盖推送+拉取合并、防抖、截断与会话事件持久化——比导航的瞬态打开测试更大。交付时 `lsp-stdio`（150 测试）、`lsp`（19）、`tool-lsp`（46）、`core/session`（287）全部绿色，提供方不变量已验证。
