# office-editor 二期调研：应用内预览与编辑（2026-10-15）

面向「保留现有的一键审查，把 Office 文件的预览与编辑做彻底」的调研结论、架构决策与分期。
所有结论都带代码/来源证据；标注 **已核实** 与 **未核实**。

## 结论速览

1. **页面取字节有路，且比预期宽**：页面 `resources/read` 单次解码上限 **8 MiB**，URI 原样透传给插件自己的 MCP server（无 scheme 白名单）。但真正的天花板是 vendored MCP SDK 的 **stdio 帧 10 MiB**（base64 膨胀 4/3）→ **按 4 MiB 分块**最稳。20 MB 文档 = 5 次读取。
2. **宿主内置预览会吞掉删除文字**：`docx-preview@0.4.0` + `renderChanges: false`（`packages/ui/src/previewPaneOfficeDocxContent.tsx:10-32`），`renderDeletedText()` 在该选项下直接 `return null`（`node_modules/docx-preview/dist/docx-preview.mjs:3622-3626`）。**我们的插件在这件事上已经比内置预览强**——继续放大这个差异。
3. **渲染库选 docx-preview（Apache-2.0，非 MIT）**：75 KB + JSZip 98 KB，纯 JS、无 eval/WASM，默认 CSP 可直接跑；`renderChanges: true` 渲染 `<ins>/<del>`，但 DOM 里**没有 author/id** → 与我们 Python 引擎的 `w:id` 按文档序对齐做 overlay。
4. **上游明确不做原生编辑器**（`docs/product-capability-map-office-computer-use.md`：DOCX/XLSX/PPTX 原生编辑器 out of scope；`zcode/feat/ui-plugin` 分支也没有 Office 相关）。所以「应用内 Office 编辑」不担心与上游撞车，但要自己承担实现成本。
5. **「打开方式」接缝（spec 里的 P1）是 M 级核心改动**：~15-20 文件 / 700-1200 行，唯一结构性风险是给 `PluginUiScopeRef` 增加第三种 `{kind:"file"}`。
6. **完整所见即所得编辑的代价很高**：SuperDoc 客户端可嵌入但 AGPL-3.0 + 商业许可（$6k/年/生产体验）；OnlyOffice/Collabora 需要自建服务端；LibreOffice headless 是 210-285 MB 的旁挂依赖（适合做 PDF 导出/缩略图，不适合做预览）。**推荐先做「预览 + 修订 + 受控编辑（修订模式）」这条自研线**。

---

## 1 页面取字节：通道、真实上限与传法

页面没有文件系统原语，只有 `callTool` / `readResource` / 订阅 / `downloadFile`（`packages/desktop/src/renderer/src/plugin-sandbox/aliasApi.ts:16-71`）。逐层上限（已核实）：

| 环节                      | 上限                                               | 证据                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 页面读资源（agent 侧）    | 8 MiB 解码（text UTF-8 / blob base64 解码）        | `bootstrap/src/zcode-protocol/mcp-ui/handlers.ts:287-319`                                                                                                                                              |
| 页面读资源（host 侧复核） | 8 MiB 解码，超限 `resource_too_large`              | `services/src/plugin-ui-bridge/pluginUiBridgeService.ts:244,283-302`；常量 `shared/src/mcp-apps/resourceMime.ts:5`                                                                                     |
| **MCP stdio 单帧**        | **10 MiB**（base64 4/3 → 实际 blob ≈ 7.4-7.5 MiB） | SDK `STDIO_DEFAULT_MAX_BUFFER_SIZE = 10*1024*1024`（`node_modules/@modelcontextprotocol/client/dist/src-D_zzAWoS.mjs:6638`），仓库未覆盖（`adapters/src/mcp/index.ts:1916-1942` 不传 `maxBufferSize`） |
| 页面 HTML                 | 16 MiB                                             | `shared/src/mcp-apps/contract.ts:134`                                                                                                                                                                  |
| 页面→磁盘下载             | 50 MiB                                             | `shared/src/mcp-apps/hostContract.ts:18`；`plugin-ui/adapters/pluginUiDownloads.ts:79-124`                                                                                                             |
| 内置预览读文件（对照）    | 25 MB（`readBinaryPreview`）                       | `services/src/file/fileService.ts:38-39,567-588`                                                                                                                                                       |

关键事实：

- **URI 原样直达插件 server**：无 scheme 白名单/归一化（链路 `pluginUiResourceSubscriptions.ts:87-93` → `pluginUiBridgeService.ts:236-246` → `sessionAccess.ts:49-53` → SDK `client.readResource`；wire schema 只限 `max(2048)` 字符）。所以我们可以自定义 `office://docx?path=…&offset=…&length=…`。
- **读资源不走 Agent 审批**；页面发起的**工具调用**才走审批与审计（`plugin-ui-bridge.callTool`）。→ **读用 resource、写用 tool** 是天然分界。
- **读超时 30 s 且无进度重置**（`adapters/src/mcp/index.ts:868-871`，与工具调用不同：工具调用有 `resetTimeoutOnProgress` 与 `_meta.timeoutMs`）。大块传输若走工具调用可重置超时。
- **初始 tool-result 载荷是 32 KiB content / 64 KiB structuredContent / 16 KiB widgetMeta**，超限整字段省略并标 `zcode/truncated`（`core/src/tool/executor/result-display.ts:100-108`；`plugin-ui/domain/pluginUiToolFeed.ts:41-63`）。→ 首批载荷只能传「句柄 + 大小 + 版本」，字节必须由页面自己去读。
- **页面资产必须内联**：沙箱协议只服务 `/`、`/index.html` 与别名脚本，其余路径 404（`desktop/src/main/pluginSandbox/protocol.ts:184-212,257`）。CSP（`desktop/src/main/pluginSandbox/csp.ts:21-61`）：`default-src 'none'`；`script-src 'self' 'unsafe-inline' blob: data:`；`worker-src 'self' blob:`；`connect-src 'none'`（除非声明）；`'unsafe-eval'`/`'wasm-unsafe-eval'` 需在资源 `_meta["zcode/csp"]` 显式声明（`shared/src/mcp-apps/contract.ts:50-57`）。
- **反向写入只能是 JSON 命令**：工具参数是 JSON（`zcode-protocol/index.ts:917-926`），没有二进制上传通道；编辑必须是「命令式」的（接受/拒绝/替换文本/改格式），不是整文件回传。

**推荐传法**：页面按 `readResource("office://docx?path=…&offset=N&length=4194304")` 分块取解码 ≤4 MiB 的 `blob`（base64 ≈5.33 MiB，距 8 MiB 与 10 MiB 都有余量）；插件 server 侧对同一文件做 mtime/size 缓存，并可用 `etag` 让页面判断是否需要重读。

## 2 渲染：宿主现状与我们能做得更好的地方

- 宿主内置预览：`docx-preview@0.4.0`，`renderAsync(buffer, …)`，`renderChanges: false`、`renderComments: false`（`packages/ui/src/previewPaneOfficeDocxContent.tsx`）。**后果：`w:del` 的删除文字在内置预览里直接消失**（`renderDeletedText → null`），审阅者看不到「删了什么」。
- docx-preview 能力（0.4.0，Apache-2.0）：`renderChanges: true` 时 `<w:ins>`→`<ins dateTime>`、`<w:del>`→`<del dateTime>`（实验性，**DOM 无 author/id**）；**不支持** `moveFrom/moveTo`、`rPrChange/pPrChange`（纯格式修订）、TOC 域；无默认样式，需自己写 CSS。
- 因此我们的做法：**渲染用 docx-preview，语义与动作仍以我们的 Python 引擎为准**——`docx_revisions_list` 给 id/author/date/位置，页面把 `<ins>/<del>` 按文档序与引擎条目对齐，贴上「接受/拒绝 + 位置 + 上下文」的浮层。修订、批注、接受/拒绝都还是我们的强项。
- 备选与真实代价：
  - `mammoth`：无修订、丢版式 → ✗
  - `SuperDoc`：客户端可嵌入、保留修订与建议模式，但 **AGPL-3.0 + 商业许可（$6k/年/生产体验）** → 只在「完整所见即所得」成为硬需求时考虑
  - `ONLYOFFICE Docs` / `Collabora`：都要自建 Document Server → 与「插件形态、零服务端」冲突 ✗
  - `LibreOffice headless`：210 MB（Linux）/285 MB（macOS）旁挂，冷启动数秒；**保留修订**、可导出带标记 PDF → 作为 `docx_export_pdf` 与缩略图的旁路（已在我们 spec 里 stub）
  - `pandoc`：单向、输出 span 而非 ins/del → 仅备选
- XLSX/PPTX（后续）：宿主已用 `@extend-ai/react-xlsx`（MIT，WASM，需 `wasmUnsafeEval`）与 `@aiden0z/pptx-renderer`（Apache-2.0），同架构可复制。

## 3 「打开方式」接缝（P1）成本

现状（已核实）：

- 内置预览按扩展名走**硬编码 if 链**（`packages/ui/src/previewPaneContent.tsx:311-323`，路由判定 `lib/officeFilePreview.ts:9-29`），字节来自 workspace 作用域的 `IFileService.readBinaryPreview`（25 MB），**远端/SSH 同样可用**（`desktop/src/host/remoteWorkspaceServiceCollection.ts:376,465`）。
- 插件 surface 只有 `availability: "session"`、`PluginUiScopeRef` 只有 `{kind:"toolCall"|"surface"}`（`shared/src/mcp-apps/contract.ts:210-215`），**没有文件匹配字段、没有文件右键/打开方式注册点**；且插件页面**只有桌面本地**才有（`usePluginUiHost.ts:21-29` 硬门）。
- 文件树/预览的「打开方式」目前是**系统编辑器**列表（`WorkspaceFileTreeRowView.tsx:352-398`、`openWithEditors.ts`），与插件无关。

最小接缝（spec 的 P1 前两条）分六步，规模合计 **M**（~15-20 文件 / 700-1200 行）：

1. surface 声明增加 `fileExtensions`（契约 + 解析 + 严格 schema 投影）— **S**
2. 匹配 hook（扩展名 → 插件 surface）— **S**
3. `PluginUiScopeRef` 增加 `{kind:"file", path}`，贯穿 scopeId / tab id / widgetState key — **M**（唯一结构性风险：漏改会让两个文件撞同一页面）
4. 入口：文件树右键与预览页「用 office-editor 打开」→ 打开 plugin-ui 侧栏标签 — **M**
5. 目标投递：文件域页面合成 `toolInput = { path, relativePath, workspacePath }`，复用现有 `tool-input` 通道，**无需新 RPC** — **S-M**
6. 回退与门控：内置预览保持为永远可用的回退；远端/SSH、无会话、插件禁用时隐藏入口 — **S**

## 4 产品面：什么叫「彻底」

竞品实况（来源见文末索引）：M365 Copilot 的编辑发生在 Office 应用里（聊天里没有编辑器）；ChatGPT / Claude 是「生成/改写文件 + 下载」，没有就地编辑；Gemini 是 Google 自家编辑器里的侧栏；WorkBuddy 未宣传内嵌 Office 编辑器；纳米Work 前端没有 Office 渲染器。**上游 ZCode 也已明确不做原生编辑器**。→ 空白区正是「**修订审阅 + 可信预览 + 受控编辑**」。

- **用户会拿来判「完成」的**：打开真实文件；每处修订都在原位、带作者/时间、增删有可读标记；单条与批量接受/拒绝；保存回同一路径后 Word 打开干净、未处理修订仍在；Agent 与用户看到**同一套修订 id**；不静默丢东西。
- **v1 现实标准**：分页接近 Word；字体替换要有提示；表格/图片/页眉页脚大体正确；不支持的构造（浮动图形、域/TOC、公式、图表、SmartArt）**降级提示**而不是画错；>8 MiB 文档明确报错；外部并发修改给冲突提示。
- **永远做不到（UX 文案要诚实）**：像素级一致与任意 DOCX 的完整所见即所得。

## 5 推荐架构与分期

| 期                  | 内容                                                                                                               | 是否动核心   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------ |
| **S1 预览**         | 页面内置 docx-preview + JSZip（内联）；按 `office://` 分块读；与引擎 id 对齐做修订浮层；**保留现有列表与一键审查** | 否（纯插件） |
| **S2 修订面补齐**   | 引擎支持格式修订（`rPrChange/pPrChange` 家族）、表格行/列、移动修订（`moveFrom/moveTo`）                           | 否           |
| **S3 受控编辑**     | 修订模式下改文本/格式（写回仍走工具：备份 + 原子替换 + mtime/hash 冲突检测）；撤销 = 回滚备份；批注可写            | 否           |
| **S4 打开方式接缝** | 第 3 节的 P1 前两条：文件树/预览「用 office-editor 打开」→ 文件域页面                                              | 是（M）      |
| **S5 可选**         | LibreOffice 旁挂出带标记 PDF/缩略图；XLSX/PPTX 复用同架构                                                          | 否           |

## 6 待拍板（两项）

- **A. 是否做 S4 的核心接缝**：收益是「像打开文件一样用我们的编辑器」，代价是 M 级跨仓改动 + 一个结构性风险点（scope kind）。不做也能用（工具卡片/side pane 打开）。
- **B. 编辑深度**：① 修订模式受控编辑（自研，零许可成本，天然与一键审查同源）② 完整所见即所得（需 SuperDoc 商业许可或 OnlyOffice 服务端）。**建议先 ①**，把「审阅」做到无死角，编辑按修订模式推进。

## 7 风险与验收

- **字体/分页**：docx-preview 依赖系统字体，CJK 与嵌入字体可能错位；`breakPages` 是近似；需在验收里明确「分页近似」。
- **`renderChanges` 是实验特性**：DOM 无 author/id；`w:del` 的删除标记可能因 run 属性不可见 → 必须用我们自己的 CSS + 引擎对齐兜底。
- **保存冲突**：备份+原子替换只防撕裂不防丢更新 → 写前比对 mtime/size/hash，冲突要显式提示。
- **撤销**：页面级撤销无法回滚服务端已发生的接受/拒绝 → 诚实模型是「撤销 = 恢复备份」。
- **大文档**：每条编辑都会重渲染整篇（`renderAsync` 无取消）；>8 MiB 明确失败；`resources/read` 无进度重置，冷启动 Python 可能吃满 30 s。
- **往返格式**：ElementTree 重写 `word/document.xml` 会改命名空间前缀（其余部件逐字节保留，已有断言）→ 每次改动都要跑一次「Word 打开」冒烟。
- **安全**：文档是不可信数据；保持 `renderAltChunks:false`、沿用链接安全策略、文档文本不得当指令。

**验收（S1）**：在真机上打开 6000 修订/800 批注的 `huge.docx`：页面渲染出正文与页面分块；插入/删除在**原位**可见（作者/时间/上下文与引擎一致）；点「接受」后重渲染并反映结果；一键全部接受/拒绝仍可用；内置预览作为对照要能看到「删除文字消失」的差异。

## 附：S1 第一刀实现记录（2026-10-15）

已落地（纯插件，零核心改动）：

- 服务端：`office://docx`（meta + 4 MiB 分块字节，base64 blob，夹取上限、路径守卫）、`office://docx/marks`
  （id/kind/文本前缀，文档序）、`resources/templates/list` 两条模板；页面装配内联 docx-preview + JSZip。
- 页面：分块读取 → `renderAsync(renderChanges:true)` → 与 marks 对齐（数量一致按文档序贴 id，否则按文本前缀配对）
  → 点列表条目定位高亮；接受/拒绝后自动重读重渲染；承载位置按产品规则分「卡片=审阅 / 侧栏=预览与编辑」。

真机实测（`/tmp/oe-big/huge.docx`，6000 修订 + 800 批注，187 KiB，1 个分块）：

```
已渲染 1 块 / 187 KiB · 修订 5990 处（对齐 5990，按文档序）
ins 节点 2995 · del 节点 2995 · 带 data-rev-id 5990 · 列表页 25 条
点列表条目 → 文档内高亮 1 处
```

即：**删除文字在页面里可见**（宿主内置预览 `renderChanges:false` 会直接吞掉），且 5990 处修订全部拿到 `w:id`。

两个「症状像宿主问题、其实出在内联」的真 bug（都已修，并加了 `node --check` 闸门防回归）：

1. 三个 minified bundle 内联进同一个 `<script type="module">` → 顶层单字母变量互相冲撞 → 整段 SyntaxError；
   真机表现是页面能加载但 `ui/initialize handshake timed out`。修法：每个 bundle 各自包 IIFE，只解构用到的名字
   （`App`、`renderAsync`）。**自检新增**：装配后的脚本写临时 `.mjs` 跑 `node --check`。
2. docx-preview 末尾在 `export{…};` 之后还有 `//# sourceMappingURL=…` → 用 `$` 锚点找导出的正则会漏判，
   导出语句留在 IIFE 里又是 SyntaxError。修法：用「最后一个 `export{`」定位。

开发回路教训（同时写进插件 spec 基线依赖段）：宿主加载的是**安装目录**
`~/.uwork/cli/plugins/cache/<marketplace>/<plugin>/<version>`（`installed_plugins.json` 的 `installPath`），
**不是** marketplace 源目录——只改源目录不会改变正在跑的页面；插件版本/页面资源仍按会话绑定，必须冷启动。

未做（按分期）：S2 修订面补齐（格式/表格行/移动）、S3 受控编辑（修订模式）、S4「打开方式」核心接缝。

## 附：证据索引

- 取字节链路：`packages/ui/src/plugin-ui/app/pluginUiResourceSubscriptions.ts:87-93`、`packages/services/src/plugin-ui-bridge/pluginUiBridgeService.ts:236-246,283-302`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/handlers.ts:245-319`、`packages/shared/src/mcp-apps/resourceMime.ts:5`
- stdio 帧上限：`node_modules/@modelcontextprotocol/client/dist/src-D_zzAWoS.mjs:6638,6646`；`apps/zcode-cli/packages/adapters/src/mcp/index.ts:1916-1942`
- 内置预览与渲染库：`packages/ui/src/previewPaneOfficeDocxContent.tsx:10-32`、`node_modules/docx-preview/dist/docx-preview.mjs:3622-3636,3971`、`node_modules/docx-preview/package.json`
- 页面 CSP 与协议：`packages/desktop/src/main/pluginSandbox/csp.ts:21-61`、`packages/desktop/src/main/pluginSandbox/protocol.ts:184-212,257`
- 预览路由与字节来源：`packages/ui/src/previewPaneContent.tsx:311-323`、`packages/services/src/file/fileService.ts:38-39,567-588`
- 插件 surface 与 scope：`packages/shared/src/mcp-apps/contract.ts:210-215`、`apps/zcode-cli/packages/contracts/src/plugins/index.ts:172-183`、`packages/ui/src/plugin-ui/adapters/usePluginUiHost.ts:21-29`
- 上游口径：`docs/product-capability-map-office-computer-use.md`、`docs/ui/office-file-preview.md`、`zcode/feat/ui-plugin`（`662c30be`）
