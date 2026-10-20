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
| typecheck | **合并净增 0 错误**；剩下 98 个全在 `packages/ui/src/im/**` 与 `WorkspaceSidebarFooter`，属分支既有红（IM 的 shared/service 契约尚未提交，实体在另一工作树）                          |
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

## 三、遗留（未在本分支处理，需产品/后续决定）

1. **IM（消息）未闭环**：`packages/ui/src/im/**` 的 98 个 typecheck 错误是既有红 —— UI 组件已提交，但 `packages/shared/src/im.ts`、`packages/services/src/im/` 等契约仍是另一工作树里的未跟踪文件。合并未改变这一点。
2. **账号体系取舍**：`oauthService` 保持"退役桩"（不发网络登录），上游 3.16.2 的账号实现未收下，相关上游测试仍会红。
3. **远控任务同步**：上游删掉 Root 层的 `webRemoteControlTaskSync*`；`useWebRemoteControlAuthSync` 与我方"已移除账号登录"的清理 effect 相抵（远控平台会长期报 signed-out）。企业身份若要覆盖手机端鉴权，需要在企业身份 Provider 接这条通道。
4. **生成物**：`THIRD-PARTY-NOTICES.md` / `third-party/inventory.json` 取上游版，发布前需在 CI 重生成。
5. **`pnpm fmt:check` 本机红**：本地 oxfmt 0.41.0 的口径与两棵树里已提交的格式都不一致（未触碰的旧文件、上游新增文件都不过），与本次合并无关；未做全仓重排。
6. 已知陈旧用例（既存，未修）：`modelProviderCodingPlan.test.ts`（引用已删除的纯函数）、`useDesktopUpdateMenu.test.ts`（源码模块已删）。

## 四、复现与验收

```bash
git worktree add ../UWork-merge-3.16 chore/upstream-3.16.2-sync   # 已有则跳过
cd ../UWork-merge-3.16 && pnpm install && pnpm typecheck
node scripts/upstream-track.mjs status --ours chore/upstream-3.16.2-sync   # 应显示"已含最新快照"
```

要点：**不要**在共享工作树里做这类大合并（本仓库常有多会话同时改同一工作树），用独立 worktree；冲突分类优先用"oxfmt 归一化 + 三方合并"，而不是逐个读冲突块。上游基线只到 3.15.1 时的方法与坑见 [`upstream-tracking.md`](./upstream-tracking.md)。
