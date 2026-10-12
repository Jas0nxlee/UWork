# 上游 v3.15.1 合并状态（2026-10-12，WIP）

上游 `zai-org/ZCode` 于 2026-10-10 发布整树快照 `aac4755`（v3.15.1），本分支把它并进 `uwork`。
**状态：`pnpm typecheck` 已全绿（0 错误）**，依赖可安装。但仍有未完成项：上游新增的远控 UI 未移植、生成物未重生成、单测未跑完（见下）。

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

## 三、typecheck 收敛过程（已完成，0 错误）

从 88 → 76 → 48 → 20 → 16 → 11 → 6 → 2 → 0，做法：
- 我方**有意裁剪**的文件（侧栏页脚、帮助菜单、侧栏、Root、WorkspaceSidebar）取回我方版本（我们的产品去掉了账号/套餐/coding-plan 入口）；
- 被上游新代码引用的、我们裁掉的**上游模块**逐个从上游恢复（oauth 系列、codingPlanStatusPanel 系列、`LoginApiKeyForm`、`desktopUpdateMenu`、`AccountConnectionLoss*` 等 19 个文件）；
- 上游 shell 传入我们侧栏的新 props（`webRemoteControlWorkspaceSwitcher` / `isWebRemoteControl` / `onWebRemoteTaskOpen` / `onWebRemoteTaskSwitchingChange`）暂时"接受但不渲染"——**远控工作区切换 UI 尚未移植**（已知功能缺口，待产品确认是否需要）。

## 四、其它校验

- `pnpm typecheck`：**0 错误** ✅
- `pnpm lint`：1 处 error —— 上游新增的编码夹具 `apps/zcode-cli/tests/gb2312.js` 不是 UTF-8，本机 oxlint 读不了（上游同款配置与文件，非本合并引入）。
- `pnpm fmt:check`：1 个上游 vendored 文档示例 `docs/electron/docs/fiddles/system/clipboard/copy/index.html` 不通过（内容与上游逐字节相同，非本合并引入）。
- `pnpm test:unit`：**528 个用例失败**。两类：
  1. 上游为「我们已裁掉的功能」写的测试（`workspaceSidebar*`、`webRemoteControl*`、`codingPlan*`、`workflowRun*` 等）——这些用例在我们产品里已不适用，需要在后续按"产品裁剪"口径删除或跳过；
  2. 真需要适配的少数：如 `packages/services/test/providerConfigRuntime.test.ts`（5 例，与数据根/旧配置迁移相关）。
- 打包与桌面 E2E：未运行。

## 五、需要产品决定的三处（建议由分发仓维护者处理）

1. **企业身份 + 企业网关接线**：`services/node.ts` 里我们的 `enterpriseIdentityAdapter` / ucas-gateway 服务构造与注册，在冲突处被上游结构覆盖（部分仍在）。桌面端企业登录窗口（`desktop/src/main/index.ts`）、`Root.tsx` 的登录入口同理。这些功能必须在上游新结构上重新接回。
2. **`codingPlanSubscriptionService`**：我方曾把它改成 provider 无关（替换 Zhipu coding-plan），上游版本实现了新的 `ICodingPlanSubscriptionService` 接口（含 `claimManualPlan`、`getBillingDiscount` 等）。本次取上游版本以先满足接口，我方设计是否重做需产品确认。
3. **生成物**：`THIRD-PARTY-NOTICES.md` / `third-party/inventory.json` 保持上游版本——本地 `node scripts/licenses.mjs notices` 因缺 9 个上游依赖的许可材料而失败（需 CI/发布流程里的 fetch 步骤），发布前必须重生成。
