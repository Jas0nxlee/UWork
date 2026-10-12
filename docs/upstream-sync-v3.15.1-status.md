# 上游 v3.15.1 合并状态（2026-10-12，WIP）

上游 `zai-org/ZCode` 于 2026-10-10 发布整树快照 `aac4755`（v3.15.1），本分支把它并进 `uwork`。
**本分支尚未完成，不能直接发布**：所有冲突已解决、依赖可安装，但 `pnpm typecheck` 仍有 76 处错误（都是"接缝"），需要按产品意图逐处接回我们的定制。

## 一、已完成的机械性合并

| 内容 | 结果 |
| --- | --- |
| 冲突文件 | 100 项（62 内容冲突 + 20 我们裁剪/上游改 + 15 上游删除 + 2 双方新增 + 1 改名），全部解决，无残留冲突标记 |
| 上游新增 | 9940 个文件（含 `packages/android`、`apps/dev-docs`、`packages/stream-animate`、`packages/web`、`packages/e2e-report`、`packages/client` 等我们此前整棵缺失的包） |
| 文件更新 | 1819 个；上游删除 6 个；改名 1 个（`profile-frontmatter.ts` → `packages/shared/src/subagent-profile-frontmatter.ts`） |
| 依赖 | `pnpm install` 通过（+863/−325），`pnpm-lock.yaml` 由上游版本重算 |

## 二、采用的处理策略（按类）

1. **元数据/清单**：`package.json` 等用 JSON 三方合并（依赖取并集；版本、我们钉死的依赖以我方为准）；`pnpm-lock.yaml` 取上游后由 `pnpm install` 重算。
2. **我们的品牌与数据根**：`ZCode→UWork`、`~/.zcode→~/.uwork` 等改名映射按文件推导后套回上游新文本（`services/node.ts`、`paths.ts`、桌面主进程、server、zcode-agent 等）。
3. **底层/接线类 18 个文件**：三方合并（base + 我方补丁 + 上游补丁），冲突处取上游结构，再手工接回我方定制。
4. **我们故意分叉的产品文件**：保留我方实现 —— `ModelProviderSection.tsx`、AIHub 插件市场三态（`PluginStoreListView/SourcesDialog`）、`README(.en).md`、`.agents/.../zcode-feature-graph.yaml`。
5. **删除取舍**：上游删除且我方源码/测试不再引用的文件接受删除（4 个上游测试 + `endpointHostname.ts` + `sessionCreateSource.ts`）；被引用的取回（`deviceMid.ts`、`webThemeSeed.ts`、`armsRumShared.*`、`prompt-trajectory/src/prompt.ts`、我们自有的 `workflow-concurrency-ceiling.ts`、`profile-model-selection.ts`）。

## 三、未完成：typecheck 76 处（集中在 UI 接缝）

| 文件 | 错误数 | 症结 |
| --- | --- | --- |
| `packages/ui/src/WorkspaceSidebarFooter.tsx` | 46 | 我方版本与上游重构后的 props/接口不匹配 |
| `packages/ui/src/WorkspaceHelpMenuButton.tsx` | 11 | 同上（helpMenuActions 已取上游实现） |
| `packages/ui/src/root/useRootOAuthEffects.ts` | 6 | 上游实现与我们保留的调用方签名不一致 |
| `packages/ui/src/settings/model-provider-section/*` | 4 | 上游新增组件与我们保留的 ModelProviderSection 混用 |
| `packages/ui/src/WorkspacePluginPreview.tsx` / `WindowsCaptionMenuButton.tsx` / `Root.tsx` | 2+2+2 | 接缝 import / 类型 |

## 四、需要产品决定的三处（建议由分发仓维护者处理）

1. **企业身份 + 企业网关接线**：`services/node.ts` 里我们的 `enterpriseIdentityAdapter` / ucas-gateway 服务构造与注册，在冲突处被上游结构覆盖（部分仍在）。桌面端企业登录窗口（`desktop/src/main/index.ts`）、`Root.tsx` 的登录入口同理。这些功能必须在上游新结构上重新接回。
2. **`codingPlanSubscriptionService`**：我方曾把它改成 provider 无关（替换 Zhipu coding-plan），上游版本实现了新的 `ICodingPlanSubscriptionService` 接口（含 `claimManualPlan`、`getBillingDiscount` 等）。本次取上游版本以先满足接口，我方设计是否重做需产品确认。
3. **生成物**：`THIRD-PARTY-NOTICES.md` / `third-party/inventory.json` 保持上游版本——本地 `node scripts/licenses.mjs notices` 因缺 9 个上游依赖的许可材料而失败（需 CI/发布流程里的 fetch 步骤），发布前必须重生成。
