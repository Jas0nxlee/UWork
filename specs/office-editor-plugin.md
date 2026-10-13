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

## P1 契约（核心 seam，本期只定义、不实现）

这三条是唯一需要动核心的部分，均设计为**通用**（不点名 Office），以便上游对齐或直接复用：

1. `PreviewPane` 的**文件视图 provider 注册点**：插件按扩展名/MIME 声明「我能提供某文件的内联视图」；命中时宿主用插件页面替代内建只读预览，失败/禁用时回退内建预览。
2. **打开方式（open-with）注册点**：文件树/预览面板出现「用 <插件> 打开」入口，把 workspace 文件路径作为工具参数交给插件。
3. （可选，最后评估）**受控文件句柄原语**：capability-gated 的 workspace 二进制读写句柄（含授权范围与审计），用于消除「每次保存一次 agent 往返」的开销。首期不做。

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

**未执行（需人工）**

- 在客户端里真正承载页面（侧栏/inline）、点接受/拒绝、公司市场安装链路与 AIHub 分发。桌面 E2E 需人工在 Chrome 里授权远程调试。
