# 上游 3.16.2 合并状态（2026-10-20）

分支 `chore/upstream-3.16.2-sync`（worktree `UWork-merge-3.16`），已推送到 `ModestXin/UWork`，PR 走 `uwork` 基线评审。
提交：`e20c4d88`（合并上游 3.16.2）+ `3d3e15e8`（锁文件重算与格式化）+ `ae783cda`（本状态文档）+ `96bee81d`（并入 uwork 基线）。
上游这次**不打 tag**（3.16.1 = `0a1fc56d`、3.16.2 = `3c5b2276`），`apps/zcode-cli` 0.16.9 → 0.17.0。

## 零、并入 uwork 基线（2026-10-20 追加）

`uwork` 在 PR #5 之后已走到 **UWork 3.16.6**，中间叠了六个版本的修复（内置登录配置与原生回调归属、企业身份会话守卫、subagent 配置按 home 隔离、非回环 HTTP 鉴权、CLI 日志保留、Windows Gen UI 资产字节、UCAS 暗色品牌等）。本次把它并进本分支（59 个文件、+2552/−715），8 处冲突按「uwork 是发布线 + 3.16.2 是新结构」解决：`.gitattributes` 与 `server/src/http.ts` 的 import 取并集、`desktopMainIpcRemote` 取 uwork 的注释与 import 并保留 3.16.2 的三个 helper、三处测试取 uwork 侧、`hostRemoteWorkspaceServices` 取我方新结构、`v4ConversationDraftEmptyStateLogo.test.ts` 接受删除。合并后 `pnpm typecheck` 仍为 98 个既有 IM 错误（净增 0）。

## 一、规模与结果

| 项        | 结果                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整树规模  | 4579 个文件、+385,796 / −131,529 行                                                                                                                                                   |
| 冲突面    | 183 个未合并路径，全部解决（详见下）                                                                                                                                                  |
| 依赖      | `pnpm install` 通过（含上游新增 `@zcode/zcode-cua`、`build:cua` prepare、radix 补丁并入 `pnpm-workspace.yaml`）                                                                       |
| typecheck | **0 错误**（上游升级后先到"净增 0、剩 98 个 IM 半成品错误"，IM 剥离后为 0；详见 §三.1）                                                                                               |
| lint      | `oxlint` **0 error**（328 warnings，属基线噪音）                                                                                                                                      |
| 顺带修掉  | 分支既有的 8 个 desktop 缺失 import（企业登录视图、MCP/附件工具、`mkdir`）；feature-graph 测试基线改为裁剪图口径（75/95/0）；两处陈旧测试（商店自动刷新 import、server-cli 品牌断言） |

## 二、183 个未合并路径的处置口径

1. **125 个仅格式差异** → 把三方都用仓库 oxfmt 归一化后做 `git merge-file`，等价于我方的差异消失 → 取上游。
2. **69 个上游删除、我方只是被格式化** → 接受删除（含 188 个 `packages/ui/test` 旧测试被上游搬进新目录）。
3. **品牌/数据根回套**（约 30 个）→ 取上游 + 把 `ZCode→UWork`、`~/.zcode→resolveUserCliRoot()`、企业身份接线逐条贴回（services/node.ts、zcodeAgent\*、desktop host、client 通道、store/server 等）。
4. **产品文件** → 以上游新结构为底，回套我们的裁剪与新增：
   - 侧栏：上游把 `WorkspaceSidebar` 换成 `project-sidebar/*`，采用新结构；把"无账号/套餐/coding-plan 入口 + `WorkspaceModeHeader` + `onOpenMessages`"移植进 `project-sidebar`。
   - `Root.tsx`/`SettingsPage`/`ChatErrorBanner`/`DesktopTopOverlay`/`WindowsTopLeftLogo`/`PreviewPane`：上游新功能保留，企业身份替换登录体系、去套餐入口、Office 就地编辑入口保留。
   - 商店列表：采用上游的 `resolvePluginStoreSegment`/`isUiPluginItem`/UI 插件推荐，把「公司」分段加回 `pluginStoreListing`。
   - i18n：按 key 取并集（上游 6981 条 + 我方补 346 条 zh-CN；品牌键保留我方；纯文案 103 条用上游）。
   - `config/provider/zcode-builtin.json`：JSON 按键三方合并 —— 保留 ucas、维持 zai/bigmodel 模板删除、补上游新模型规则与 `xiaomi-mimo-token-plan`（18 个模板）。
   - 其它：README（我方重写 + 上游 changelog 折叠）、feature-graph（裁剪图 + 上游 3.16.2 新节点）。

## 三、集成修复与验收边界（2026-10-21 更新）

1. **IM（消息/频道）已按决定从本分支剥离**（提交 `dcc30bf1`）：这批 UI 组件是并行会话误提交进来的半成品，其契约从未提交（`packages/shared/src/im.ts`、`packages/services/src/im/`、`IImService`、`IPlatformService.setImBadgeCount`、`IServiceAccessor.imService` 全树都找不到），98 个 typecheck 错误全部来自它。已删除 `packages/ui/src/im/**`（37 文件）+ 8 个 IM 测试、拔除 15 个共享文件里的接线、移除仅 IM 使用的 127 个 i18n 键 ×2 语言；剥离后 `pnpm typecheck` 由 98 → **0**。**IM 的 UI 可从 `8ba8704a` 取回**，契约齐备后与 UI 一起单独提 PR；设计稿仍在 `specs/messaging-and-channels.md`。副作用：`sidePaneTabMatchesWorkspace` 的"空 workspaceKey 仍可见"不变式暂时没有用例钉住。
2. **账号体系保留退役合同**：`oauthService` 不恢复账号、不发网络登录；RPC 会话事件回归验证 signed-out 与凭据不变。套餐设置的陈旧入口断言改为验证个人 Provider 导航与刷新 owner，未为迁就上游测试恢复旧账号功能。未运行全量根 UT，不将定向测试通过描述为全仓全绿。
3. **远控兼容已修复（2026-10-21）**：UWork Main 显式使用自建 HMAC 配对，手机构建默认 HMAC；保留现有自建端点 env 注入，缺失自建端点时失败关闭。随机配对与企业身份/OAuth 无关，不能通过企业 Provider 的 signed-in 通知或企业 JWT 替代官方 V2 JWT。上游 V2 作为隔离兼容实现保留，无账号仍拒绝。原 `webRemoteControlTaskSync*` / `initialWorkspaceList` 已由 Host projectService/windowProjectDirectory 全局项目目录替代；当前 SideBar 导航复用同一 identity/switcher，不恢复第二份任务索引。Loopback 双端互通与明暗/宽窄屏浏览器夹具已验证，真实生产 relay、企业微信和新安装包未验收。
4. **第三方材料**：按当前生产依赖图重生成 `THIRD-PARTY-NOTICES.md` / `third-party/inventory.json` 并验证输入新鲜度。Fortune Sheet 与 saxes 补齐固定版本原文；ExcelJS 的旧 unzipper 定向升级至 0.12.5，移除 binary/buffers/chainsaw，并用两项补丁修复 workbook model 屏障和 forceStream 提前终结。材料清单仍列审查义务；新鲜度通过不代表严格完整许可审查完成。
5. **`pnpm fmt:check` 本机红**：本地 oxfmt 0.41.0 的口径与两棵树里已提交的格式都不一致（未触碰的旧文件、上游新增文件都不过），与本次合并无关；未做全仓重排。
6. **陈旧用例已修复**：`modelProviderCodingPlan.test.ts` 验证当前个人设置入口；`useDesktopUpdateMenu.test.ts` 直接覆盖实际 Windows 菜单，复现并修复迟到 idle 快照覆盖实时 checking 的问题。治理为 Office 与帧调度登记真实 managed 边界，消除三个 Office 依赖环；同一 contract 层支持多个精确根，不放宽层间方向。全局 lint 仍为 400 行，仅本次继承的存量大文件按精确路径保留 800 行上限。

## 四、复现与验收

```bash
git worktree add ../UWork-merge-3.16 chore/upstream-3.16.2-sync   # 已有则跳过
cd ../UWork-merge-3.16 && pnpm install && pnpm typecheck
node scripts/upstream-track.mjs status --ours chore/upstream-3.16.2-sync   # 应显示"已含最新快照"
```

要点：**不要**在共享工作树里做这类大合并（本仓库常有多会话同时改同一工作树），用独立 worktree；冲突分类优先用"oxfmt 归一化 + 三方合并"，而不是逐个读冲突块。上游基线只到 3.15.1 时的方法与坑见 [`upstream-tracking.md`](./upstream-tracking.md)。

## 五、本次合并验证

- Node 24.14.0 / pnpm 10.33.2 冻结安装、桌面 `build:no-runtime-assets` 与 Agent CLI 构建通过。
- 供应商/企业身份/品牌 CI 对应 Node 测试 163 项通过；菜单、个人供应商、OAuth RPC 与归档聚焦套件通过。
- HMAC 真实 loopback、窗口 owner 交接、持久化/轮换/取消、原 V2 独立门禁及项目目录导航有定向回归；手机/宽屏 × 明暗四组合浏览器夹具通过。
- 不包含真实生产 relay、企微扫码或新安装包的端到端验收；不发新版本、不发布安装包。

### 推送门禁追加修复

- 19 个 `node:test` 文件原先误入 Vitest；现在唯一清单同时驱动 Vitest 排除与真实 Node runner，推送和 CI 始终执行该套件（109 项通过），不会仅排除不执行。
- 隐藏祖先目录（例如 managed worktree）使官方 glob 的默认 dot:false 无法匹配配置路径。按实际根构造转义后的 force trigger，隐藏/特殊字符/Windows 路径与普通业务部分选择都有真实 API 回归；affected 的官方选择和全量跳过定义不变。
- 纯净原 PR 的 Desktop 聚焦基线 17 红、Services 26 红已分别修到 55/55 与 144/144。另复跑原 PR 的历史 OAuth completion race 得到 13 红，相关实现/测试与当前 SHA-256 完全一致；未恢复已退役账号，也未将该既有失败说成通过。
- 配置变更触发官方全量选择时，按既有合同跳过 Vitest UT，报告明确未执行。定向回归和 Node 原生套件的执行结果另行记录；未宣称全仓单测全绿。
