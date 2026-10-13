# office-editor 插件

**在应用界面里审阅/处理 Word 修订**（首期只做 DOCX），以**插件形态**交付：不往核心集成编辑器，能力全部落在插件里。

## 组成

| 路径                            | 作用                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `.zcode-plugin/plugin.json`     | 插件清单：声明 `skills` 与 stdio MCP server（`python3 server/server.py`，宿主注入 `${ZCODE_PLUGIN_ROOT}`）  |
| `server/server.py`              | 极简 MCP stdio 服务器（纯标准库）：`initialize`/`tools/list`/`tools/call`/`resources/list`/`resources/read` |
| `server/docx_revisions.py`      | OOXML 修订引擎（纯标准库 `zipfile` + `ElementTree`）：列出/接受/拒绝 `w:ins`、`w:del`                       |
| `ui/editor.html` + `ui/page.js` | 沙箱页面：列出修订、逐条接受/拒绝；经宿主官方 `App` 桥调用本插件工具                                        |
| `ui/vendor/`                    | 官方 `@modelcontextprotocol/ext-apps` 浏览器 bundle（MIT，随 SDK 升级重新拷贝）                             |
| `skills/office-editor/SKILL.md` | 让模型也能驱动同一套工具                                                                                    |
| `verify/mcp_smoke.py`           | 冒烟测试：造一份带修订的 docx，走 stdio JSON-RPC 验证列出/接受/复查                                         |

## 工具

- `docx_revisions_list({ path })` → 修订与批注清单
- `docx_revisions_resolve({ path, action: "accept"|"reject", ids? })` → 处理修订（原地写：先备份 `<stem>_backup.docx`，再「临时文件 + 原子替换」）
- `docx_open_editor({ path })` → 返回 `ui://office-editor/editor.html` 页面引用（宿主据此承载页面）
- `docx_export_pdf({ path })` → **未实现**（需 LibreOffice/soffice，明确返回错误，不假装成功）

## 开发期使用

```bash
python3 plugins/office-editor/verify/mcp_smoke.py     # 自检（会造样本 docx 到临时目录）
```

在应用里加载：把 `plugins/office-editor` 作为插件源安装（公司市场 AIHub 或本地 zip），或在与宿主相同的 Python 环境下手动跑 `server/server.py` 验证协议。

## 边界与安全

- 文档内容视为**不可信数据**：不解析进主渲染进程，页面在沙箱 webview 内；不把文档里的文字当成指令。
- 所有读写都发生在**工具调用**里（复用 Agent 的审批与审计路径）；页面自身没有文件系统能力。
- 写操作**必然可回滚**：先备份再原子替换；正文以外的 zip 部件逐字节保留。
- 首期**不做自动保存**；没有编辑器 UI 的 WYSIWYG（P0.1 换 SuperDoc/canvas-editor 时再引入）。
