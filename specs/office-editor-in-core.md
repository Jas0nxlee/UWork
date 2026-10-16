# 内核 DOCX 编辑器（在 UWork 里直接编辑 Word 文件）

状态：已实现（分支 `chore/upstream-v3.15.1-sync`）。组件落点 `packages/ui/src/officeEditor/`。
引擎与选型调研见同类文档 `office-in-core-research.md`（在插件仓 `UWork-plugin/specs/`）。

## 1 目标与非目标

**目标**：在 UWork 侧栏里直接编辑 `.docx`，操作与观感对标 Word/WPS（功能区 + 纸张居中 + 分页），
显式保存写回原文件并留备份。

**非目标（本期明确不做）**：

- 不做 Word 修订记录（`w:ins`/`w:del`）：canvas-editor 无修订语义，这是调研里的 C2；
- 不拉起本机 Office、不引入 ONLYOFFICE/Collabora 这类服务端重型方案（用户的硬约束）；
- 不动预览面板（保持只读，上游契约），编辑器是独立的一屏。

## 2 引擎选择（决策）

**canvas-editor**（MIT）：壳 808 KB + docx 插件 711 KB，canvas 渲染、自带分页/光标/选区/表格/图片工具栏。
否掉的：SuperDoc（自包含不可行：引擎 12.7 MB 从 jsdelivr 拉、worker 用相对路径、引擎本身是独立商业包）、
ONLYOFFICE/Collabora（服务端重型）。许可按仓库口径核查（`scripts/licenses.mjs`，AGPL 为红）。

## 3 数据与接口

| 环节 | 契约                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 读   | `IFileService.readBinaryPreview({ path })`（base64 + totalBytes）+ `stat`（size/mtimeMs 作为 baseRevision） |
| 写   | `IFileService.writeBinaryFile({ path, dataBase64, expectedRevision?, backup: "sibling" })`                  |
| 冲突 | 写前比对 size/mtime，不一致则拒绝（`File revision mismatch`），界面提示"重新加载或另存副本"                 |
| 备份 | 写前复制为 `<stem>_backup.docx`，已存在则 `_backup-2`、`_backup-3`…（唯一持久回退手段）                     |
| 落盘 | 先写 `<path>.<base36>.tmp` 再 `rename`（原子替换）                                                          |
| 上限 | 8 MiB 内原地编辑；超过则只提示只读（超大文档在任何浏览器编辑器里都不可用）                                  |
| 慢   | 解析超过 3s 时如实提示"会很卡"（实测：500 段 76ms / 6000 段 957ms / 20000 段 4.4s）                         |

命令映射在 `CanvasOfficeEditorPane.runRibbon`：功能区语义命令 → 引擎命令，参数形态**照抄 canvas-editor 官方 demo**
（特殊形态：`executePainter` 要 `{isDblclick}`、`executeInsertElementList` 的日期/复选框元素形状、
`executeImage/Hyperlink/Latex/AddWatermark` 收对象、撤销/重做前先 `focus()`）。

## 4 界面规则（功能区）

宽度是**量出来的**，不设宽度阈值：侧栏可拖（窄约 650px、宽 1000px+），开始标签完整铺开要 1656px，
任何固定阈值都会导致"内容比容器宽"的横向滚动条，所以按 Word/WPS 的做法逐级降级：

1. 分组一行铺开；
2. 放不下的分组收进末尾的「»」菜单（点开仍是完整的一组命令）；
3. 单个分组自己都放不下时收成「分组名 ▾」按钮。
   取舍顺序由数据里的 `essential` 决定：必要分组优先，其余按原顺序；**任何宽度下都不出现横向滚动条**。
4. 分组行高度固定下限 **88px**（开始标签的样式库卡片最高，实测 85px）：切换标签时整块不跳动。

其它定死的规则（都对应真机反馈）：

- **下拉面板 portal 到 body + fixed 定位**：功能区有 `overflow-x-auto`，普通绝对定位会被裁掉（"字体下拉被困在栏里"）；
- **面板从触发器继承前景色/背景色**：portal 脱离主题作用域后 token 失效（"下拉文字颜色不对"）；
- **同屏只允许一个下拉打开**（单一打开源）：点第二个时第一个自动关闭，不依赖点击传播的细节；
- **字体给跨平台字体栈**（`宋体 → SimSun, Songti SC, STSong, serif`）：只写 Windows 字体名在 macOS 上解析失败，
  表现为"换了字体没变化"；
- **底纹只用浅色**：深色底纹会吞掉黑字，看起来像文字消失；
- **选区色 `#0969da` / 25%**：默认色在深色应用里与正文对比太弱，像"字没了"。

## 5 验收与回归检查

两条检查都在无头 Chromium 里跑（需要 `OFFICE_CHECK_CHROMIUM` 指到 `chrome-headless-shell`，
本机在 `~/Library/Caches/ms-playwright/chromium_headless_shell-1208/`）：

- `pnpm --filter @zcode/ui check:office-editor`（`scripts/check-office-editor-commands.mjs`）：
  在真实引擎里逐条跑功能区命令，断言 ① 不抛错 ② 不吞内容 ③ 取值类命令的元素属性真的被设置（标题级别、字号、字色、
  底纹、字体）④ 渲染哨兵用**截图字节数**（GPU 画布在无头环境 `getImageData` 取不到数据，会假通过）。
  命令矩阵从 `officeRibbonTabs.ts` 正则抽取，避免清单与实际功能区脱节；抽取失败**显式失败**（曾经静默当"无参调用"，
  把参数问题伪装成引擎 TypeError）；矩阵少于 40 条即失败（防误删命令）。
- `pnpm --filter @zcode/ui check:office-ribbon-layout`（`scripts/check-office-ribbon-layout.mjs`）：
  esbuild 打真实组件 + tailwind 现场生成 CSS，在 [1600,1280,1040,900,760,660,560,460] 各宽度逐个标签量
  ① 分组行高度是否一致 ② 内容宽度是否超容器（不许横滚）③ 窄宽度下「»」是否可点开且有足够命令
  ④ 下拉互斥（点第二个只剩一个面板）⑤ 面板是否在视口内。

## 6 本次验证记录（2026-10-16）

| 项               | 结果                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 命令回归         | 44 条命令 + 6 项取值断言，失败 0（含收进 `A▾` 菜单的增大/减小字号、删除线、上标、下标、清除格式）                              |
| 布局回归         | 8 个宽度全部通过：分组行一律 88px、无横向溢出；460px 下开始标签的「»」里有 23 个可点项、下拉互斥 1 个、面板在视口内            |
| 真机（Electron） | **未验证**：本机 dev 实例占用单例锁，改动已提交但需要用户重开应用确认观感                                                      |
| 清理             | 删掉 SuperDoc 路线的残留（对照版编辑位 300 行、资产拷贝脚本、`@superdoc/*` 依赖、渲染进程下 40 MB 资产），开发启动不再拷 40 MB |

**已知缺口**（不假装）：

- 改动落成 `w:ins`/`w:del` 的修订模式（C2）未开始；「修订」按钮目前映射到引擎的痕迹显示开关；
- 入口未正式化：目前只能从对话里被 Agent 提到的文件卡片进编辑器，文件树/打开方式、独立侧栏标签、远端能力探测都还没有；
- 字体栈只在 macOS 上人工确认过可切换，Windows 字体名的回退顺序未实测。
