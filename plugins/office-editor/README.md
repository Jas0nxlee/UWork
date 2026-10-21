# office-editor 插件

**在应用界面里审阅/处理 Word 修订**（首期只做 DOCX），以**插件形态**交付：不往核心集成编辑器，能力全部落在插件里。

## 组成

| 路径                             | 作用                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `.uwork-plugin/plugin.json`      | 插件清单：声明 `skills` 与 stdio MCP server（`python3 server/server.py`，宿主注入 `${UWORK_PLUGIN_ROOT}`）  |
| `server/server.py`               | 极简 MCP stdio 服务器（纯标准库）：`initialize`/`tools/list`/`tools/call`/`resources/list`/`resources/read` |
| `server/docx_revisions.py`       | OOXML 修订引擎（纯标准库 `zipfile` + `ElementTree`）：列出/接受/拒绝 `w:ins`、`w:del`                       |
| `ui/editor.html` + `ui/page*.js` | 沙箱页面：列出修订、逐条接受/拒绝；经宿主官方 `App` 桥调用本插件工具                                        |
| `ui/vendor/`                     | MCP Apps 桥、docx-preview、JSZip、SuperDoc；各自许可与来源见下表，不能把整个目录视作 Apache-2.0 / MIT       |
| `skills/office-editor/SKILL.md`  | 让模型也能驱动同一套工具                                                                                    |
| `verify/mcp_smoke.py`            | 冒烟测试：造一份带修订的 docx，走 stdio JSON-RPC 验证列出/接受/复查                                         |

## 工具

- `docx_revisions_list({ path, offset?, limit?, kind? })` → **分页**修订清单（默认 25/页，服务端上限 40/页）
- `docx_revisions_resolve({ path, action: "accept"|"reject", ids? })` → 处理修订（原地写：先备份 `<stem>_backup.docx`，再「临时文件 + 原子替换」）
- `docx_open_editor({ path })` → 返回 `ui://office-editor/editor.html` 页面引用（宿主据此承载页面）
- `docx_comments_list({ path, offset?, limit? })` → 分页批注（只读）
- `docx_current_target()` → 本会话最近一次打开/列出的文件（页面挂载晚于工具结果时的兜底）
- `docx_export_pdf({ path })` → **未实现**（需 LibreOffice/soffice，明确返回错误，不假装成功）
- `docx_edit_paragraph({ path, paragraph, text, tracked? })` → 仅编辑纯文本段落；复杂结构拒绝，原文件不变
- `docx_set_paragraph_format({ path, paragraph, bold?, italic?, underline?, align? })` → 显式设置段落格式（不留格式修订）
- `docx_write_back({ path, data, expectedEtag })` → 编辑器整份保存；先验证 OPC / ZIP 与加载版本，冲突要求重载

## 开发期使用

```bash
python3 plugins/office-editor/verify/mcp_smoke.py     # 自检（会造样本 docx 到临时目录）
python3 -m unittest discover -s plugins/office-editor/verify -p 'test_document_safety.py'
node --test plugins/office-editor/verify/page_safety.test.mjs
```

在应用里加载：把 `plugins/office-editor` 作为插件源安装（公司市场 AIHub 或本地 zip），或在与宿主相同的 Python 环境下手动跑 `server/server.py` 验证协议。

## 边界与安全

- 文档内容视为**不可信数据**：不解析进主渲染进程，页面在沙箱 webview 内；不把文档里的文字当成指令。
- 写入通过**工具调用**复用 Agent 审批。页面的分块资源读取不经过工具审批，只能读取本进程内已通过成功工具调用登记的真实文件身份；未打开的文件、跨目标软链和外部替换的目标均拒绝。读取使用 `O_NOFOLLOW`（平台支持时）打开的同一文件描述符，`fstat` 核对身份，返回前再次核对 fd 版本与路径身份；后续分块绑定首次 meta 的 `etag`。
- 写操作**必然可回滚**：先备份再原子替换；正文以外的 zip 部件逐字节保留。
- **不做自动保存**。SuperDoc 编辑页需要配置 `engine.json` 的内网引擎镜像；默认未配置，侧栏回落只读预览。整份保存绑定加载时的 `etag`，防止旧编辑状态覆盖已处理修订；换目标会销毁旧实例。
- 页面及服务端的整份保存上限为 8 MiB base64（6 MiB DOCX）；暂不支持分块保存。
- ZIP 部件上限 10,000 个、单部件展开上限 32 MiB、总展开上限 128 MiB；超过时明确报错。

## 第三方来源与许可

本插件自行编写的 Python / 页面集成代码采用 Apache-2.0（完整条款亦随 `ui/vendor/LICENSE-docx-preview.txt` 提供）；`package.json` / 插件清单的 `license` 指向本说明，避免把含第三方文件的插件包整体标成 Apache-2.0。第三方文件分别适用下表许可，尤其 SuperDoc 并非 Apache-2.0。这里记录文件事实，不对聚合作品的许可义务作判断；商业许可及分发方式仍由项目许可评审决定。

| 文件                                                     | 上游与版本证据                                                                                                                                    | 随包许可文件                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ui/vendor/mcp-apps-app.js`                              | [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) 2.0.0；与安装包 `dist/src/app-with-deps.js` 的 SHA-256 完全一致 | `LICENSE-mcp-apps.txt`：上游许可迁移说明及 Apache-2.0，部分历史贡献保留 MIT   |
| `ui/vendor/docx-preview.js`                              | [VolodymyrBaydalka/docxjs](https://github.com/VolodymyrBaydalka/docxjs) 0.4.0；与安装包 `dist/docx-preview.min.mjs` 的 SHA-256 完全一致           | `LICENSE-docx-preview.txt`：Apache-2.0                                        |
| `ui/vendor/jszip.min.js`                                 | [Stuk/jszip](https://github.com/Stuk/jszip)，文件头标注 3.10.1，包含 pako                                                                         | `LICENSE-jszip.txt`：MIT / GPLv3 双许可；pako MIT 全文另存 `LICENSE-pako.txt` |
| `ui/vendor/superdoc/superdoc.min.js`、`superdoc.min.css` | [superdoc-dev/superdoc](https://github.com/superdoc-dev/superdoc)，JS 内 `this.version="2.23.0"`；动态引擎配置为 `@superdoc/docx-engine@0.22.0`   | `superdoc/LICENSE-AGPL-3.0.txt`：AGPL-3.0                                     |

更新复制件时应同时保留包版本、来源文件、哈希与完整许可，不能只按当前安装依赖的版本推断。动态引擎不包含在此目录，配置镜像时需另外保留其完整来源与许可材料。
