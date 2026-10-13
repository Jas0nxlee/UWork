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

- **插件的形态**：插件清单声明 `mcpServers.office`（`type: "stdio"`，`command` 由宿主注入 `${ZCODE_PLUGIN_ROOT}`）；服务器名由宿主命名空间化为 `plugin:office-editor:office`。
- **工具即权限边界**：所有读写都通过工具调用发生（复用 Agent 的审批与审计路径）；插件页面本身没有任何文件系统原语，页面只能经宿主桥调用这些工具。首期不做自动保存，只有显式的「接受/拒绝/另存」动作。
- **文档=不可信内容**：本插件不解包渲染第三方 HTML 进主渲染进程；页面在沙箱 webview 内运行，且不把文档内容当指令执行（沿用 `docs/ui/office-file-preview.md` 的既有边界）。
- **写入必须可回滚**：任何原地修改前先写 `<stem>_backup.docx`（已存在则 `_backup-2`…），并用「临时文件 + `os.replace`」原子替换。
- **首期只做 DOCX 修订（revisions）**：列出/接受/拒绝 `w:ins`、`w:del`；批注（`w:comment`）只读列出。XLSX/PPTX 不在本期。
- **诚实标注未实现**：`export_pdf` 明确返回「未实现（需 LibreOffice）」而不是假装成功。

## P1 契约（核心 seam，本期只定义、不实现）

这三条是唯一需要动核心的部分，均设计为**通用**（不点名 Office），以便上游对齐或直接复用：

1. `PreviewPane` 的**文件视图 provider 注册点**：插件按扩展名/MIME 声明「我能提供某文件的内联视图」；命中时宿主用插件页面替代内建只读预览，失败/禁用时回退内建预览。
2. **打开方式（open-with）注册点**：文件树/预览面板出现「用 <插件> 打开」入口，把 workspace 文件路径作为工具参数交给插件。
3. （可选，最后评估）**受控文件句柄原语**：capability-gated 的 workspace 二进制读写句柄（含授权范围与审计），用于消除「每次保存一次 agent 往返」的开销。首期不做。

## 验收

- `docx_revisions_list`：在带 1 个 `w:ins`、1 个 `w:del` 的样本上返回 2 条修订，字段含 id/kind/author/date/text。
- `docx_revisions_resolve(accept)`：接受后 `w:ins` 解包（文字保留）、`w:del` 整体删除；再次列出为 0；原文件已被 `_backup.docx` 备份；zip 其余部件逐字节保留。
- `docx_revisions_resolve(reject)`：拒绝后插入文字消失、删除文字恢复为正文。
- 协议面：`initialize` / `tools/list` / `tools/call` / `resources/list` / `resources/read` 冒烟通过；`resources/read` 返回的 HTML < MCP 页面上限（16 MiB），mimeType 为 `text/html;profile=mcp-app`。
- **未验证（需人工）**：应用内页面渲染、在页面里点「接受/拒绝」、侧栏承载与回收。桌面 E2E 需要人工在 Chrome 里授权远程调试，无人值守跑不了（见仓库既有约束）。

## 本次验证记录（2026-10-12）

- `python3 plugins/office-editor/verify/mcp_smoke.py` → **20 项断言全过**：initialize 回显协议版本、tools/list 暴露 4 个工具、列出样本（1 插入 + 1 删除，带作者）、接受单条插入后插入文字保留且 `w:ins` 解包、备份文件已生成、**无关 zip 部件逐字节一致**、拒绝剩余删除后 `w:delText` 还原为 `w:t` 且修订清空、`docx_export_pdf` 明确 `isError`、`resources/read` 返回页面（**417 KiB**，mime `text/html;profile=mcp-app`，在宿主 16 MiB 上限内）。
- `pnpm exec oxfmt --check specs/office-editor-plugin.md plugins/office-editor` → 全部通过；`pnpm exec oxlint plugins/office-editor` → 0 warning / 0 error。
- 仓库级 `pnpm lint`（310 warnings / 1 error）与 `pnpm fmt:check`（1 个上游 vendored HTML）与改动前**同一状态**，本次未新增问题。
- 配置改动：`.oxfmtrc.json` / `.oxlintrc.json` 的 `ignorePatterns` 各加一条 `plugins/office-editor/ui/vendor/**`（vendored 的官方 ext-apps 浏览器 bundle，418 KiB，属第三方产物；bundle 与其 MIT 许可同放在 `ui/vendor/`，随 SDK 升级重新拷贝）。
- **未执行（需人工）**：应用内页面渲染与在页面里点接受/拒绝、侧栏承载与回收、公司市场安装链路、AIHub 分发。桌面 E2E 需人工在 Chrome 里授权远程调试，无人值守跑不了（仓库既有约束）。
