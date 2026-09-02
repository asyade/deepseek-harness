# Agent Note：把 MCP resources 做成由模型拉取的助手工具

Status: implemented

[English](2026-09-02-mcp-client-resources-bridge.md) | 中文

## 问题

[MCP 客户端](2026-07-07-mcp-client-plugin.zh.md)只桥接工具。发布 resources（文件、数据库 schema、日志、应用状态）的服务器无人可用：`resources/list` 与 `resources/read` 从未被调用，包 README 把 Resources 记为暂缓，理由是"桥接需要 harness 侧的注入决策"。阻塞点是这个决策，而不是协议工作量。

## 决策

MCP 把 resources 定义为由应用控制：规范定义协议方法，把"内容如何抵达模型"留给宿主决定。存在两种宿主模式——用户附加式，由选择界面把 `@` 提及解析为注入的上下文（Cursor）；以及模型拉取式，由宿主发布读取工具、模型自行决定（Claude Code 的 `ListMcpResources`/`ReadMcpResource`）。harness 没有附件选择界面，因此模型拉取式是它唯一能表达的模式，注入决策也就落为一对有界工具，而不是一套提示词装配策略。

`packages/mcp/mcp-client/src/resources.ts` 拥有这两个助手工具；`syncTools` 把它们追加进自己正在构建的世代。

**同一个世代，而非第二个。** 助手工具通过与服务器自身工具相同的原子"dispose 旧的、注册新的"交换完成注册，因此与之一同出现、重新同步和消失。独立的注册路径需要自己的回滚与 dispose 规则，却毫无收益。

**先能力门控，再配置门控。** 在 `initialize` 中未声明 `resources` 的服务器不会贡献任何东西，也绝不会向它发送任何 `resources/*` 请求。`resources.enabled: false` 连能力检查也一并跳过。

**名称冲突时服务器自己的工具获胜。** 发布了名为 `list_resources` 的工具的服务器保留该名称；助手工具被跳过并记录警告。反过来——助手工具遮蔽模型本可调用的真实工具——会静默移除服务器功能。

**不缓存、不订阅。** 每次调用读取的都是实时状态，因此 `resources/subscribe`、`notifications/resources/updated` 与 `listChanged` 与正确性无关且未实现：不存在可能过期的缓存副本。重新同步、重连与 dispose 因此不需要任何 resources 专属处理。

**边界作用于最终输出的文本。** `list_resources` 分页抽取直到 `maxListEntries`，并回传可恢复该列表的页游标；`read_resource` 在整个拼接结果上（而非逐条）于 `maxContentChars` 处截断。不可信的服务器数据以防御方式渲染——缺少 `uri` 的描述符、非对象的内容条目、二进制 `blob`，各自变为一行方括号诊断，而不是缺失的数据或进入上下文的 base64。`resolveResourceBounds` 是显式的解析步骤，与 `resolveReconnectPolicy` 对应。

## 考虑过的替代方案

**做一个兄弟插件 `mcp-resources`，不改动 `mcp-client` 以便向上游提交。** 在估算成本后否决：该插件需要对同一台服务器另开连接，对 stdio 而言意味着第二个子进程，且服务器的 `command`/`args`/`url` 会重复出现在两条可能漂移的 `cordis.yml` 配置行中。另一条路——让 `mcp-client` 把它的活跃连接发布为服务——对同一个包的改动比直接把桥接加进去更大。

**把资源内容自动注入系统提示词。** 否决：内容无界且对某一回合大多无关，token 成本落在每次请求上，而资源变化会使提示词前缀失效。列出元数据很便宜，读取才是昂贵调用，而只有模型知道哪个资源要紧。

**像图片工具结果那样，把二进制内容路由进附件存储。** 暂缓而非否决：resources 不携带可与图片路由相比的能力证明，而给出大小与类型的诊断如实说明了模型能据以行动的内容。README 将其记为开放方向。

**通过 MCP completion API 补全 URI 模板。** 暂缓：模板被列出供模型展开。补全是另一片协议面，其价值取决于 harness 并不具备的选择界面。

## 测试

单元（`tests/resources.spec.ts`，mock 客户端）：能力门控存在与缺失时的注册、证明未发起能力调用的禁用路径、冲突优先级及其警告、dispose 移除两个助手工具、分页抽取、上限及其恢复游标、调用方游标的透传、模板渲染、annotations 渲染、标签优先 `title` 而非 `name`、非法描述符、读取拼接与截断、证明 base64 不外泄的二进制诊断、空结果、服务器错误传播、缺失 `uri`，以及 `resolveResourceBounds` 的每个分支。E2E（`tests/mcp-client.e2e.ts`，无需密钥）：stdio fixture 服务器新增一个文本资源与一个二进制资源；真实进程测试经真实协议列出两者并各读取一次。快照：无——助手工具产生普通文本工具结果，没有新的呈现形态。

## 影响

- 对具备 resources 能力的服务器，每次请求会多两个工具定义。这是可发现性的固定成本；`resources.enabled: false` 可以去掉它。
- 模型只在自己索取时才看到资源。回合中途变化的资源在下次调用时被观察到，绝不会被推送。
- `resources` 是两种传输上的新增配置面。
- Prompts 仍未桥接：它需要 harness 缺少的提示词模板概念，而 resources 并不需要。
