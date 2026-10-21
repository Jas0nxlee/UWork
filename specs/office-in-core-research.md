# office 编辑：融进 UWork 内核的调研与方案（2026-10-15）

结论先行：**编辑器走内核是对的**（它一次性消掉插件路线上的所有墙：沙箱 CSP、无文件原语、引擎要联网、每次动作都走审批）；
但**必须分两步**——先把「审阅闭环 + 文件写回」内核化（纯 MIT/Apache，无许可问题，立刻比上游只读预览强），
**编辑器引擎是第二步且卡在一个商业决策上**（SuperDoc 的引擎是**私有许可**，不只是 AGPL）。

## 1 为什么内核化能解掉插件的墙（已核实）

| 插件路线的墙                                                          | 内核侧现状                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 沙箱 `connect-src 'none'`、引擎只能从 http(s) 载入、worker 走相对 URL | **主渲染进程没有 CSP**（`packages/desktop/renderer/index.html` 无 CSP meta，主进程只给插件沙箱/小工具窗设 CSP）→ eval/wasm/worker 都能用 |
| 页面没有文件原语、每 4 MiB 分块、32/64 KiB 初始载荷上限               | 直接走 `IFileService`（`readBinaryPreview` 25 MB 上限、远端/SSH 已对齐）                                                                 |
| 页面发工具调用每次走 Agent 审批                                       | 原生 UI，一次「写回文件」确认足够                                                                                                        |
| 引擎资产必须内联/镜像                                                 | pdf.js worker、xlsx **wasm** 已是 `?url` 资源 + worker 的既有模式                                                                        |

## 2 内核侧缺什么、加什么（已核实）

- **没有任何通用文件写 API**（`IFileService` 只有一个 `writeWorkspaceFileSearchIgnore`）；"代码编辑器"其实不存在（只读 shiki，`openInEditor` 是外部编辑器）；全仓**没有** dirty/未保存机制可抄，只有设置表单的 dirty-guard。
- 现成可用的**冲突/历史**原语：文件监听（150 ms 防抖；`usePptxFileWatch` 的"监听父目录、latest-wins、绝不用陈旧字节提交"就是模板）、git checkpoint（临时 index → commit-tree，不污染用户工作区）、会话级"整轮撤销 Agent 改动"。
- **最小改动**（合计 M）：
  1. `packages/shared/src/protocol.ts` + `services/src/file/*` 新增 **`writeBinaryFile`**（`expectedRevision` + 可选 sibling 备份 + 临时文件原子替换；模板＝agent 侧 fs adapter 的 `writeTextFile`/`atomicWrite`）——**S**；同时要更新 web 的穷举 stub 与远端能力探测（远端仅在新版 server bundle 上存在该方法，老远端会 `Method not found`，必须**能力探测后隐藏入口**，而不是保存时才失败）。
  2. 编辑位放在**既有 `code-viewer` 侧栏标签**里（`AnimatedSidePanePanel` 已渲染 `PreviewPane`）——**M**（新增一个编辑组件 + dirty/关闭守卫 + 只读工作区/远端降级）。
  3. 冲突与外部改动：save 前比对 `(size, mtimeNs)`（后续升到内容 hash），冲突弹「另存副本 / 重载磁盘版本 / 覆盖（二次确认）」，草稿永不丢；外部改动靠 watcher 触发重载——**S**。
  4. 引擎（见第 3 节的决策）——**M–L**。
- **不要动 `PreviewPane` 本体**：上游把「只读、不暴露编辑/保存」「预览态不进任务快照」写成了产品契约；把它改成编辑器＝每轮上游合并都要解冲突（v3.15.1 那次 100 处冲突就是样本）。编辑器另开一种标签类型，文件 IO 全部走 `IFileService` 端口——这正是上游能力图里要求的「Renderer 不拥有文件 IO/转换/保存/版本」（他们规划中的 **Host Office Document Service**），端口化之后我们的编辑器将来能平滑换到上游服务上，而不是被删掉。

## 3 引擎与许可（这一节是决策，不是技术）

**SuperDoc 的真实许可结构（新发现，之前只看到 AGPL）**：壳 `superdoc` 是 AGPL-3.0（2.1/2.2 曾短暂标 MIT），而**引擎 `@superdoc/docx-engine` 是独立私有包**：许可写明"非开源"，无协议时只授权"AGPLv3 允许的用途"，禁止独立分发/镜像/逆向。官网定价：Community（AGPL，测试与个人）免费、**Business $6,000/年 = 1 个"生产文档体验"**、Enterprise 定制。
→ **对外分发（含发给企业客户）必须先买商业授权**；AGPL 合规也换不来引擎的使用权。而且**本仓库自己的门禁** `scripts/licenses.mjs` 把 AGPL 判为 `red-agpl` 直接 fail——把 AGPL 引擎塞进内核与项目自身政策冲突，也是企业采购的常见红线。

其余候选的许可/能力结论（细节见文末来源）：canvas-editor（MIT，1–1.5 MB，**无修订支持**，issue #703 已关）、Univer（Apache 内核，但 DOCX 导入导出属 Pro 商业层）、TipTap/CKEditor/TinyMCE（DOCX 往返都要**付费 + 云端转换服务**，离线不可用）、ONLYOFFICE/Collabora/LibreOffice（Word 级保真，但都是**几百 MB 的服务端/旁挂**）、商业 SDK（Aspose/GroupDocs/Spire：仅 OEM 级允许第三方分发，$3.6k–$24k，且 .NET/JVM 旁挂）。

**三条可选路线**：

| 路线                                   | 功能                                                                                  | 许可/成本                                                                                                                                  | 客户端体积                                | 结论                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------- |
| **A. SuperDoc v2 内核嵌入**            | 完整所见即所得 + 修订/批注                                                            | 需买 Business $6k/年（须书面向厂商确认：安装在发给客户的安装包里算不算"1 个体验"、能否关闭 license key/telemetry、是否支持自定义资产地址） | ~25–27 MB 资产（镜像 `dist-cdn/` 全目录） | 功能最全；**卡在商务决策**                                       |
| **B. 自研"审阅 + 修订模式编辑"内核化** | 二审一改：列修订（含位置/上下文）、逐条/批量接受拒绝、修订模式下改文本/格式、批注只读 | 纯 MIT/Apache，**零许可成本**                                                                                                              | <2 MB                                     | **建议先做这一步**：它就是"比上游只读预览强"的差异点，且不阻塞 A |
| **C. 自托管 ONLYOFFICE/Collabora**     | Word 级保真 + 协作                                                                    | 自托管 AGPL/MPL（内部使用通常可），但要服务端 + 存储对接                                                                                   | 客户端近零                                | 要一台服务器；与"轻量化"冲突，除非愿意运维                       |

## 4 交付方式（若走 A）

- 把 `@superdoc/docx-engine@0.22.0/dist-cdn/` 整目录（引擎 13.36 MB、主 worker 10.61 MB、review worker 0.77 MB、style.css 31 KB）与壳（1.38 MB + 105 KB CSS）**同版本锁定**。
- **离线交付用主进程的 loopback 静态服务**（127.0.0.1 随机端口 + path token）最干净：应用仍完全离线、不依赖外网/内网镜像，Shell 的 http(s) 白名单天然满足；插件路线也能复用同一个地址（`connectDomains` 加 `http://127.0.0.1:<port>`）。在此之前 `engine.json` 的 `baseUrl` 指向内网镜像也能用（当前实现）。
- **合规缺口要现在补**：插件里 vendored 的 `ui/vendor/superdoc/*`（含 AGPL LICENSE 文本）**在 `third-party/inventory.json` / `embedded-components.json` 里没有任何条目**；无论 A 还是 B 都要登记（A 还要登记私有引擎的许可文件与协议编号，并注明不可再分发）。

## 5 产品与交互（与上游不冲突的口径）

- **三个面**：对话卡片＝只做接受/拒绝（我们已实现）；**预览面板保持只读**（上游契约）；**编辑器＝独立侧栏标签**（每文件一个，去重同 `pluginUiSidePaneTab`）。
- **修订默认开**：文档已有未处理修订、或用户从审阅卡片进入时，编辑默认记为修订；干净文档写作时默认直接编辑。模式开关**常显**，切换不静默。
- **只显式保存**（不做自动保存）；脏标记 + 关闭守卫；草稿可落沙箱持久存储（IndexedDB，重启仍在），但必须标注"草稿（未写回文件）"。
- **冲突**：写前校验 baseRevision；冲突给三个出口（另存副本 / 重载 / 覆盖二次确认）；**有脏草稿时拒绝 Agent 写入**（上游能力图要求"Skill 与 Editor 草稿隔离，取消不撤销已提交文件"）。
- **撤销三层**：编辑器内 Ctrl+Z（仅本会话）→ **备份文件**（`<stem>_backup[-N].docx`，唯一持久手段，需要一个小 UI 做"恢复/清理"）→ 复用上游"撤销 Agent 本轮修改"。
- **上游撞车判定**：功能不撞（上游明确把原生编辑器列为规划且内核未定）；**接缝会撞**——所以预览面板不改、文件 IO 端口化、编辑器独立标签。上游官方 DOCX skill 已经在做修订（`track_revisions=True`），且它的写回约定（默认另存 `<stem>_updated.docx`，明确要求才原位覆盖且先备份）与我们的规则一致 → **修订词汇表可以统一**。

## 6 分期建议

| 期     | 内容                                                                                                                                                                  | 许可/依赖     | 规模 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---- |
| **C1** | 内核化审阅闭环：`writeBinaryFile` + 侧栏编辑标签（只读渲染 = 我们现有 docx-preview 路径，**显示删除文字**）+ 修订列表/位置上下文/逐条与批量接受拒绝 + 冲突守卫 + 备份 | 纯 MIT/Apache | M    |
| **C2** | 修订模式编辑（改文本/格式落成 `w:ins`/`w:del`）——把插件里已验证的引擎语义**移植到 TS**（Python 版留作 CI 一致性预言机）                                               | 纯 MIT/Apache | M    |
| **C3** | 引擎接入（A 路线）：loopback 资产服务 + SuperDoc 挂载 + trackChanges + 冲突/保存复用 C1 端口                                                                          | **商业决策**  | M–L  |
| **C4** | 批注可写（回复/解决）、格式修订/移动/表格行（修订面补齐）、PDF 导出（LibreOffice 旁挂，MPL 可随包分发）                                                               | ——            | M    |

## 7 待你拍板

1. **C1 是否现在开工**（不依赖任何许可决策，且能让"审阅"立刻比上游强）——我建议直接做。
2. **编辑器引擎走 A（买 SuperDoc，$6k/年 + 厂商书面确认）还是 C（自托管文档服务）**，或者先停在 C1/C2（"审阅+修订模式编辑"，不承诺 Word 克隆）。
3. **C2 的移植策略**：TS 移植（推荐，核心无 Python 依赖）还是保留 Python 作为旁挂。

## 附：来源与证据索引

- 内核 seam：`packages/ui/src/PreviewPane.tsx:1244-1294,1482-1494`、`packages/services/src/file/file.ts:21-80`、`fileService.ts:38-39,567-588`、`apps/zcode-cli/packages/adapters/src/fs/index.ts:291-330,700-745`、`packages/services/src/fileWatcher/fileWatcherService.ts:59-141`、`packages/ui/src/hooks/usePptxFileWatch.ts:79-129`、`packages/services/src/git/gitCheckpoint.ts:13-18`、`packages/ui/src/lib/workspaceSidePane.ts:50-58,1023-1033`、`packages/desktop/vite.config.ts:179,221-236`、`packages/ui/src/previewPaneOfficeXlsxContent.tsx:3,10`、`packages/desktop/src/renderer/index.html`（无 CSP）、`vitest.config.ts:110-146`、`packages/desktop/wdio.conf.ts:275-281,4511-4543`
- 上游口径：`docs/product-capability-map-office-computer-use.md:12,18,19,30,48,60,113-114,151,160`、`docs/product-capability-map.md:332,344`、`docs/ui/office-file-preview.md:11,119,121,157`、`docs/ui/pptx-preview.md:10,13,18,37,46-70`、`UI_PLUGIN.md:25,85-103,296-333,339-376,430-445`、`packages/shared/src/mcp-apps/contract.ts:207-215`、官方 skill `documents-plugin/skills/docx/routes/edit.md:5-7`、`references/ooxml.md:33-34`
- 许可：`LICENSE`（Apache-2.0）、`scripts/licenses.mjs:77,89-111`（AGPL=red-agpl）、`unpkg.com/@superdoc/docx-engine@0.22.0/DOCX-ENGINE-LICENSE.md`、`superdoc.dev` 定价、`docs.superdoc.dev/resources/license/`；canvas-editor（MIT，无修订）、Univer（Pro 才有 I/O）、TipTap/CKEditor/TinyMCe（付费+云转换）、ONLYOFFICE（AGPL 服务端）、Collabora（MPL-2.0 服务端）、LibreOffice（MPL-2.0，Linux 207 MB / macOS 284 MB）、Aspose/GroupDocs/Spire（OEM 级才可分发）
- 本仓插件侧已完成、可复用的实现：`plugins/office-editor/server/docx_revisions.py`（修订语义/接受拒绝/位置上下文/写回安全/修订模式编辑）、`ui/page.js`（审阅卡片/对齐/翻页）、`specs/office-editor-plugin.md`、`specs/office-editor-editing-preview-research.md`
