# 插件：office-editor（界面内操作 Word）

| 字段       | 内容                                                                               |
| ---------- | ---------------------------------------------------------------------------------- |
| 变更       | 新增一个**插件形态**的 Office（首期 DOCX）能力：界内修订审阅与编辑入口，核心零分叉 |
| 用户入口   | 文件树 / 预览面板的 Word 文件 → 工具调用 `open_editor` → 侧栏/inline 插件页面      |
| 执行所有者 | 插件侧 stdio MCP server（本机 Python 标准库）；页面在宿主沙箱 webview 内           |
| 范围外     | 完整 WYSIWYG 编辑器（P0.1 才引入 SuperDoc/canvas-editor）；云端执行；跨端同步      |

## 背景与判断

调研（2026-10-12）表明，腾讯 WorkBuddy 与 360 纳米Work 宣传的「在页面里直接操作 Word」实现方式是 **agent 在授权目录/云电脑里读写真实文件 + 文件面板 + 自然语言迭代**，而不是内嵌 Word 编辑器：纳米Work web 端的前端指纹里只有 `pdfjs`/`katex`/`highlight.js`，没有任何 Office 渲染或编辑库；WorkBuddy 官方口径是「用户在授权目录范围内可直接读取与写入文件，成果直接保存至本地」。

因此本项目不做「核心集成一个编辑器」，而是：

1. **能力放进插件**（`skills` + `mcp` + 插件页面），随公司市场（AIHub）独立发版；
2. **核心只留通用 seam**（见下「P1 契约」），保证上游将来自己做原生 Office 编辑器时，我们既可以对齐、也可以整体停用/卸载；
3. 上游 v3.15.1 合并的教训：核心分叉越少，未来合并越便宜。

## 产品规则

- **插件的形态**：插件清单声明 `mcpServers.office`（`type: "stdio"`，`command` 由宿主注入 `${UWORK_PLUGIN_ROOT}`）；服务器名由宿主命名空间化为 `plugin:office-editor:office`。
- **工具即权限边界**：所有读写都通过工具调用发生（复用 Agent 的审批与审计路径）；插件页面本身没有任何文件系统原语，页面只能经宿主桥调用这些工具。首期不做自动保存，只有显式的「接受/拒绝/另存」动作。
- **文档=不可信内容**：本插件不解包渲染第三方 HTML 进主渲染进程；页面在沙箱 webview 内运行，且不把文档内容当指令执行（沿用 `docs/ui/office-file-preview.md` 的既有边界）。
- **写入必须可回滚**：任何原地修改前先写 `<stem>_backup.docx`（已存在则 `_backup-2`…），并用「临时文件 + `os.replace`」原子替换。
- **审阅必须给位置与上下文**（2026-10-13 真机评审反馈）：只列"改了什么"不够——审阅者不知道改动在文档哪儿、周围是什么，就无法判断该不该接受。因此每条修订必须带：段落序号、表格坐标（若在表格内）、**最近标题**、以及**变更前后文**（把被删除的文字也放进上下文）；页面按"位置 → 上下文（变更高亮）→ 元信息"呈现。
- **首期只做 DOCX 修订（revisions）**：列出/接受/拒绝 `w:ins`、`w:del`；批注（`w:comment`）只读列出。XLSX/PPTX 不在本期。
- **诚实标注未实现**：`export_pdf` 明确返回「未实现（需 LibreOffice）」而不是假装成功。

## 大文档与大量标注（2026-10-14 压测与实现）

**问题**：宿主的工具结果有字节上限（`content` 32 KiB / `structuredContent` 64 KiB）。实测一份
1600 条修订 + 300 条批注的文档，**一次性返回体 1061 KiB**（33 倍于上限）——不分页必然被截断，
页面会拿到不可用的数据。这是"很多标注"场景的硬约束，不是体验优化。

**实现**：`docx_revisions_list` / `docx_comments_list` 分页（`offset`/`limit`，默认 25/页、
**服务端上限 40/页**、`kind` 可只看插入或删除）；总数与分布（插入/删除/批注）始终全量返回。
服务端按 `(绝对路径, size, mtime_ns)` 缓存解析结果，翻页/刷新不重解析；写回后清缓存。

**实测（3.9 MB `document.xml`、6000 条修订、800 条批注、20 个表格）**

| 动作                        | 耗时                                 | 备注                 |
| --------------------------- | ------------------------------------ | -------------------- |
| 首次解析 + 首页             | 73 ms                                | XML 解析占大头       |
| 跳到第 5001 条（缓存命中）  | 0.2 ms                               | 翻页与页码无关       |
| 接受 10 条（含写回 + 备份） | 189 ms                               | 写回整份 3.9 MB 部件 |
| 页体大小                    | 15.9 KiB（25 条）/ 25.4 KiB（40 条） | 均在 28 KiB 安全线内 |

## P1 契约（核心 seam，本期只定义、不实现）

这三条是唯一需要动核心的部分，均设计为**通用**（不点名 Office），以便上游对齐或直接复用：

1. `PreviewPane` 的**文件视图 provider 注册点**：插件按扩展名/MIME 声明「我能提供某文件的内联视图」；命中时宿主用插件页面替代内建只读预览，失败/禁用时回退内建预览。
2. **打开方式（open-with）注册点**：文件树/预览面板出现「用 <插件> 打开」入口，把 workspace 文件路径作为工具参数交给插件。
3. （可选，最后评估）**受控文件句柄原语**：capability-gated 的 workspace 二进制读写句柄（含授权范围与审计），用于消除「每次保存一次 agent 往返」的开销。首期不做。

## 基线依赖（页面的可用前置，2026-10-14 确认）

**页面不是"装了就能画出来"——它还需要宿主那条线合进来。** 宿主页面体系（`packages/ui/src/plugin-ui/`、
`packages/shared/src/mcp-apps/`、沙箱 `pluginSandbox` preload）是**上游 v3.15.1 才带进来的**；`uwork`（3.16.0）基线上
这些源码不存在，`_meta.ui` 无处可渲染，宿主按契约回退成普通工具卡——基线分支上冷启动实测：主文档 DOM 里**没有**
iframe/webview/沙箱目标，日志里也没有 `plugin-ui-bridge` 行（是"无事发生"，不是报错）。

因此本插件的交付顺序与验收口径：

- **基线分支（`uwork`）**：MCP 工具可用（列修订/处理修订/导出）。页面**不会**出现，属预期；不要当成插件缺陷排查。
- **上游合并线（`chore/upstream-v3.15.1-sync`）**：页面才真正挂载——本 spec 的页面类验收全部在这条线上取得。
- **安装形态随宿主而变**：3.15.1 宿主只认 `.zcode-plugin/` + `${ZCODE_PLUGIN_ROOT}`；仓库内的 `.uwork-plugin/`
  - `${UWORK_PLUGIN_ROOT}` 需要带 UWork 别名的新宿主（`UWORK_MANIFEST_PATH`/`UWORK_*` env）。本地实测走
    `~/.uwork/cli/plugins/marketplaces/uwork-local-dev/office-editor/`（**拷贝**，非软链），改完插件要重新拷 + **冷启动**。
- **页面挂载期的瞬态**：冷启动恢复任务时，卡片会在会话的 MCP app 连接登记前就 prepare，宿主回 `-32001`；
  该窗口由宿主侧修复（`specs/plugin-ui-session-warmup-resilience.md`，有界退避自动重试），插件侧无需处理。

## 二期：预览与编辑

「保留一键审查，把预览与编辑做彻底」的调研结论、架构决策与分期见
[`specs/office-editor-editing-preview-research.md`](./office-editor-editing-preview-research.md)（2026-10-15）。要点：
页面按 4 MiB 分块读 `office://` 资源取字节（真实天花板是 MCP stdio 帧 10 MiB，不是 8 MiB）；
渲染用 docx-preview（Apache-2.0，`renderChanges:true`）+ 我们引擎的 id/作者/位置做浮层；
宿主内置预览 `renderChanges:false` 会**吞掉删除文字**，这是我们已有的差异优势；
「打开方式」接缝（P1 前两条）为 M 级核心改动，待拍板。

### 承载位置（产品规则，2026-10-15 定）

**审阅在对话卡片里做，预览与编辑在侧边大窗口里做。**

- 对话卡片 = 审阅位：一键审查（逐条/全部接受拒绝）、修订列表与位置上下文、批注；文档预览按需展开（默认不渲染，避免在窄卡片里渲染整篇）。
- 侧边大窗口（侧栏 / `fullscreen`）= 文档位：自动渲染文档、修订标记叠加、逐条定位；后续的编辑能力只在这一位提供。
- 判据**只认宿主上报的 `displayMode === "fullscreen"`**，不按宽度猜：对话区本身可能很宽（实测 1010 px），按宽度猜会把卡片误判成大窗口。
- 新的工具调用由 `docx_open_editor` 的 `_meta.ui.preferredDisplayMode = "fullscreen"` 自动打开一次侧栏；**恢复出来的历史卡片不会**（描述是当时落盘的），因此卡片上必须有「在侧栏打开」按钮（走 `requestDisplayMode`，同一页面实例换承载位置）。

## 插件命名契约（UWork 命名 + 既有生态兼容）

结论先说：插件交互面里 **`.zcode-plugin`、`ZCODE_PLUGIN_ROOT`、`@zcode/*` 都不是"忘了改品牌"**，而是宿主契约与上游内部命名——
`.zcode-plugin` 是加载器唯一认识的清单目录（`marketplace.ts` 的候选表），`ZCODE_*` 由宿主注入，`@zcode/*` 是包作用域
（全仓 2179 个文件）。**用户可见的部分早已是 UWork**（数据根 `~/.uwork`、插件缓存 `~/.uwork/cli/plugins/cache/…`、
`zcode → UWork` 的显示名映射、i18n 基本清零）。

因此本期给"我们自己的东西"加了一层 **UWork 命名别名**，同时保持既有生态可加载：

| 面       | UWork（首选）                                                                       | 兼容（继续支持）                                     |
| -------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 清单目录 | `.uwork-plugin/plugin.json`                                                         | `.zcode-plugin` / `.claude-plugin` / `.codex-plugin` |
| 占位符   | `${UWORK_PLUGIN_ROOT}` / `${UWORK_PLUGIN_DATA}` / `${UWORK_PROJECT_DIR}`            | `${ZCODE_*}` / `${CLAUDE_*}`                         |
| 注入 env | `UWORK_PLUGIN_ROOT` / `UWORK_PLUGIN_ID` / `UWORK_PLUGIN_DATA` / `UWORK_PROJECT_DIR` | `ZCODE_*` / `CLAUDE_*`（同时注入）                   |
| 新建插件 | SkillHub 包装产物落在 `.uwork-plugin/`                                              | 历史安装的 `.zcode-plugin/` 目录照旧可读             |

发现顺序为 UWork 优先、随后回退；两者同时存在时取 `.uwork-plugin`。**本插件自身即采用 UWork 命名**（`.uwork-plugin/plugin.json` + `${UWORK_PLUGIN_ROOT}`），
所以它同时是这层契约的第一个消费者与回归样本（`test/pluginUworkAliases.test.ts`、`test/officeEditorPlugin.test.ts`）。

**将来重构自研底座时要改哪些**：只需处理这张表里的"面"（外加包作用域 `@zcode/*` 与目录 `apps/zcode-cli` 这类内部标识），
不需要碰插件生态——因为别名层已经让两侧同时可用；反过来若现在就全量改名（2179+ 文件），每次上游合并都要重新做一遍，
v3.15.1 合并的 100 个冲突就是代价样本。

## 验收

- `docx_revisions_list`：在带 1 个 `w:ins`、1 个 `w:del` 的样本上返回 2 条修订，字段含 id/kind/author/date/text，以及位置与上下文：`paragraph`（段落序号）、`table`（`{index,row,cell,rows,cells}` 或 null）、`nearestHeading`（`{text,level}` 或 null）、`context`（`{before,after}`，变更前/后文，删除的文字也在内）、`paragraphText`。
- `docx_revisions_resolve(accept)`：接受后 `w:ins` 解包（文字保留）、`w:del` 整体删除；再次列出为 0；原文件已被 `_backup.docx` 备份；zip 其余部件逐字节保留。
- `docx_revisions_resolve(reject)`：拒绝后插入文字消失、删除文字恢复为正文。
- 协议面：`initialize` / `tools/list` / `tools/call` / `resources/list` / `resources/read` 冒烟通过；`resources/read` 返回的 HTML < MCP 页面上限（16 MiB），mimeType 为 `text/html;profile=mcp-app`。
- **未验证（需人工）**：应用内页面渲染、在页面里点「接受/拒绝」、侧栏承载与回收。桌面 E2E 需要人工在 Chrome 里授权远程调试，无人值守跑不了（见仓库既有约束）。

## 本次验证记录（2026-10-12）

**已执行**

- 插件自检 `python3 plugins/office-editor/verify/mcp_smoke.py` → **20 项断言全过**（协议握手、4 个工具、列出样本 1 插入 + 1 删除、接受后插入文字保留且 `w:ins` 解包、备份存在、**无关 zip 部件逐字节一致**、拒绝后 `w:delText` 还原为 `w:t`、修订清空、`docx_export_pdf` 正确 `isError`、页面 417 KiB / mime `text/html;profile=mcp-app`）。
- **宿主真实加载链路**（`apps/zcode-cli/packages/adapters/test/officeEditorPlugin.test.ts`，`tsx --test`）：`validateLocalPluginPath` 0 error；`resolvePluginMcpServers` 解析出 `plugin:office-editor:office`，命令 `python3 <plugin>/server/server.py`，注入 `UWORK_PLUGIN_ROOT`/`UWORK_PLUGIN_ID`（并保留 `ZCODE_*`）。
- **官方 MCP SDK 客户端**（同一测试内）：连接 stdio、列出 4 个工具、`docx_revisions_list` 得到 1 插入 + 1 删除、`docx_open_editor` 返回 `_meta.ui.resourceUri`、`resources/read` 取回页面（>1000 字符）。
- **页面在浏览器里真渲染**：把装配后的 426,699 字节页面经本地 HTTP 打开 —— 标题/工具条正常、418 KiB 的 ext-apps bundle 无语法问题；无宿主时按设计回退。**由此发现并修掉一个问题**：原先只在 `typeof App === "undefined"` 时提示，而 bundle 已定义 `App`，于是 `connect()` 悬挂会让页面只剩灰按钮——现在加了 5 秒握手超时与失败提示（实测回退提示可见）。
- **UWork 命名别名**（`test/pluginUworkAliases.test.ts`）：`.uwork-plugin` 单独存在可被发现、旧 `.zcode-plugin` 仍可加载、两者并存时取 `.uwork-plugin`、`${UWORK_PLUGIN_ROOT}` 与 `${ZCODE_PLUGIN_ROOT}` 都能展开、四种 env 同时注入。
- `oxfmt --check` / `oxlint` 于新增与改动文件干净；`pnpm lint` 111 warnings / 0 errors（该基线原有 111/0）；`pnpm typecheck` 0 error，`adapters`、`bootstrap` 两个包各自的 `tsc --noEmit` 0 error。
- CI 增加一步：`Validate office-editor plugin and UWork plugin naming aliases`（`tsx --test` 跑上面两个测试文件）。

### 真机验收（2026-10-13，dev 客户端 + 真实模型 + 真实沙箱页面）

- **页面真的能挂载**：`docx_open_editor` 的工具描述带 `_meta.ui.resourceUri` 后，宿主创建了
  `ZCode Plugin Sandbox` webview + `zcode-sandbox://plugin-…` iframe，页面在对话内联卡片里渲染。
- **页面能自举拿到目标文件**：页面显示的是真实的 `/tmp/oe-test/sample.docx`（经由 `ontoolinput` 或
  兜底工具 `docx_current_target`），不再停在"等待宿主传入文件"。
- **列表与位置/上下文全部正确**：实测两条修订分别渲染为「插入/删除 + 接受/拒绝 + 第 2 段 ·
  「一、概述」+ 上下文（插入文字绿下划线、删除文字红删除线，被删文字也出现在上下文里）+ 作者/时间/id」。
- 两个**平台行为**（真机才发现，文档未写）：
  1. 页面引用**只从 `tools/list` 的工具描述 `_meta` 读**（`apps/zcode-cli/packages/adapters/src/mcp/descriptor.ts`），
     写在调用结果上不会被识别——表现就是"页面不出现、回退成普通工具卡"。
  2. 插件版本与页面资源**按会话/宿主进程绑定**：装完新版本必须**冷启动客户端**才生效
     （用户指出并实测确认），热装只改 cache 目录不会改变已运行的会话。
- 体验观察（待定）：页面自己发起的工具调用（列修订/处理修订）**每次都走一次权限确认**，
  对"点一下接受/拒绝"的交互偏重；评估"始终允许本项目"或按会话授权是否合适。

**未执行（需人工）**

- 在客户端里真正承载页面（侧栏/inline）、点接受/拒绝、公司市场安装链路与 AIHub 分发。桌面 E2E 需人工在 Chrome 里授权远程调试。
