# Pre-push Hook

仓库现在通过 Husky 接管 Git 的 `pre-push`。

- 安装依赖后会执行根脚本 `pnpm prepare`，自动完成 Husky 安装。
- `pre-push` 会执行 `pnpm run verify:pre-push`。
- 根 `pnpm test` 先执行包级 Node 原生单测，再执行 Vitest 单测；`pnpm test:unit` 保留 Vitest 专用入口，不包含桌面 E2E。
- Bugfix：单测脚本里的 E2E exclude glob 必须加引号；否则 shell 会先把 `packages/desktop/test/e2e/**/*.test.ts` 展开成真实文件列表，导致 Vitest 把多余文件当成 filters，同时又被 exclude 排除，最终报 `No test files found` 并阻止 push。
- `verify:pre-push` 依次执行 lint、数据库/架构检查、Node 原生单测和 push 范围的受影响 Vitest 单测；任一实际检查、测试或脚本自身失败都会阻止 push。

这样可以在代码推到远端前，先用更快的静态检查拦住明显问题，再把单测问题拦在本地，同时保留 `pnpm test:e2e` 作为桌面端 E2E 的独立入口。

## 与 CI 的关系（PR 上的 `checks` job）

PR 只跑 `.github/workflows/desktop-release.yml` 的 **`checks`** job（`build` / `publish` 在 PR 上被跳过），它是 pre-push 的超集。**推 PR 前建议按同样顺序在本地跑一遍**，免得合并前才发现 CI 红。当前 `checks` job 的顺序：

```bash
pnpm install --frozen-lockfile   # 锁文件必须与 package.json 一致，否则第一步就红
pnpm lint                        # 0 error 门禁（warning 不拦）；注意 max-lines=400
pnpm typecheck
pnpm architecture:check
pnpm exec vitest run packages/desktop/test/genUiVendorCheckout.test.ts \
  packages/desktop/test/packagedDesktopCdp.test.ts \
  packages/desktop/test/enterpriseLoginIpcBindings.test.ts \
  packages/ui/test/v4ConversationDraftEmptyStateLogo.test.ts   # 该文件已随上游 3.16.2 删除：参数匹配不到文件不会失败，保留以与 CI 逐字对齐
node scripts/build-desktop-agent-cli.mjs
node --test packages/safe-extract-zip/test/*.test.cjs packages/safe-extract-zip/contract.test.ts \
  scripts/test/desktop-release.test.mjs scripts/test/desktop-asar-runtime.test.mjs \
  scripts/test/desktop-packaging-config.test.mjs scripts/test/web-remote-uwork-integration.test.mjs \
  scripts/test/arms-patch-install-contract.test.mjs scripts/test/generate-third-party-notices.test.mjs \
  scripts/third-party-notices.test.mjs
pnpm exec tsx --test apps/zcode-cli/packages/adapters/test/officeEditorPlugin.test.ts \
  apps/zcode-cli/packages/adapters/test/pluginUworkAliases.test.ts
pnpm test:unit:node
pnpm exec tsx --test packages/services/test/identitySessionGuard.test.mts \
  packages/services/test/ucasGatewayIdentityRace.test.mts \
  apps/zcode-cli/packages/adapters/test/skillhubSource.test.ts \
  apps/zcode-cli/packages/adapters/test/userStorageRoot.test.ts \
  apps/zcode-cli/packages/adapters/test/marketplaceTrust.test.ts \
  scripts/test/uworkBranding.test.ts scripts/test/desktopEnterpriseIdentity.test.ts \
  packages/services/test/appCaCertSecurity.test.mts scripts/test/dependencySecurity.test.ts \
  scripts/test/mcpOAuthIssuer.test.ts
pnpm exec vitest run packages/server/test/serverInfoHttp.test.ts packages/server/test/hostCapability.test.ts \
  packages/server/test/botsHttp.test.ts packages/desktop/test/serverRemoteConnection.test.ts
pnpm audit --prod --audit-level=high --json > dependency-audit.json
```

三个已踩过的坑：

- **`max-lines`（400）是 error**：新增或扩容的数据表 / 用例表很容易越线（`packages/ui/scripts/lib/officePptxEditCases.mjs` 就因此让 CI 红过）。仓库既有做法是在文件头加 `/* eslint-disable max-lines -- <为什么拆不开> */`（见 `scripts/licenses.mjs`、`scripts/upstream-track.mjs`）。
- **CI 里点名的测试文件允许不存在**：Vitest 的位置参数是过滤器，只要还有一个匹配就不报错（例如 `packages/ui/test/v4ConversationDraftEmptyStateLogo.test.ts` 已随上游 3.16.2 删除，CI 仍然绿）。
- `pnpm install --frozen-lockfile` 与 `pnpm audit` 需要网络；离线环境跑不了这两步，别把它们当成"已通过"。

## 开发环境与版本管理工具

pre-push 直接使用当前 `PATH` 中的 pnpm / Node，不强制依赖 mise。此前 hook 外层的
`mise exec` 虽能选择指定版本，却使已用 nvm 等方式准备好环境的开发者也必须安装 mise，
否则检查尚未开始就会失败。

```text
开发者准备 Node / pnpm（mise、nvm 或其他方式）
    → Git hook 保留 push ref 信息并清理 Git local env
    → pnpm run verify:pre-push
    → lint / 架构检查 / 受影响单测
```

- 仓库负责声明工具版本和执行检查；个人环境负责让合适的 Node / pnpm 可被 Git 找到。
- mise 仍是可选的开发入口；`mise.toml`、`mise-run.mjs` 和现有子进程 PATH 保护保持不变。
- GUI Git 客户端若找不到 Node / pnpm，可在个人 `~/.config/husky/init.sh` 中初始化自己的
  版本管理环境，参见 [Husky 官方说明](https://typicode.github.io/husky/how-to.html#node-version-managers-and-guis)。
- 缺少命令或检查失败仍然阻止 push；hook 不自动安装工具，不静默跳过检查。
- 本次只解除 hook 对 mise 的依赖，不新增版本检查，也不修改现有开发、CLI/SEA 或 CI 的版本要求。

## Node 原生单测的 runner 边界

测试 API 决定执行器：直接导入 `node:test` 的包级单测必须交给 Node 原生 runner，
不能由 Vitest 收集后当作零测试。空的或无效的 Node 文件清单必须报错，不得退化为 Node 的全仓自动发现。唯一清单是 `scripts/node-unit-test-files.mjs`；
根 Vitest 从该清单排除，`pnpm test:unit:node` 则先验证清单边界与 runner 接线，再以
当前 Node 加 `tsx` loader 的 `--test` 模式实际执行整份清单。`node scripts/run-node-unit-tests.mjs --list`
列出全部实际运行路径，不根据某次失败、包名或来源临时筛掉测试。

```text
包级 node:test 源文件 → 唯一精确清单 → Node + tsx --test → 真实失败阻断
                           └→ 根 Vitest exclude（只修正 runner 归属）
包级 Vitest 测试 → 根配置项目 → 官方 changed/related → 原有部分/全量合同
```

`verify:pre-push` 和桌面发布 CI 调用同一个 `test:unit:node` 入口；Node 清单始终实际执行，
不参与 affected 的官方选择，也不随 Vitest 全量跳过。原有 `.mts`、CLI、E2E 和独立归档安全
套件保留各自已经正确的 Node/专用入口，不并入根 Vitest。

边界回归扫描根包级测试范围中的直接 `node:test` 导入，与唯一清单双向核对，新增或删除未登记
文件必须失败；真实 Vitest `globTestSpecifications` 不得包含该清单。临时 `.ts` 测试夹具通过
`.js` 导入 TypeScript 源，证明 loader 接线有效；成功必须执行断言，失败必须保留非零退出。 子进程隔离 Node worker 的私有 `NODE_TEST_CONTEXT`，防止测试框架上下文被误当成新 runner 的上下文而零测试成功退出。
该修复不改变 affected 选择算法或“全部根 Vitest 项目才算全量”的定义，也不表示历史 Vitest
失败已经通过。配置修复若被官方识别为全量影响，报告必须写明“跳过，未执行”。

## Affected Unit Tests

### 目标与入口

`pnpm test:unit:affected` 使用 Vitest 官方 changed/related 和 Vite 模块依赖分析。薄入口只负责 Git 基线、Push 工作区检查、全量跳过和结果说明；不维护自建依赖图、基线消费者图、来源过滤或 Node 测试选择。

| 入口                                         | 官方选择范围                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm test:unit:affected`                    | `changed: true`，包含已暂存、未暂存、未跟踪文件                                       |
| `pnpm test:unit:affected --base <commit>`    | `changed: <SHA>`，包含任务起点之后的提交及当前未提交改动                              |
| `pnpm test:unit:affected --scope push`       | 显式基线优先；默认用 hook remote SHA，首次推送用 HEAD 与 origin/staging 的 merge-base |
| `pnpm test:unit:affected --files <files...>` | 官方 related，供 lint-staged 等显式文件入口使用                                       |
| 上述入口加 `--dry-run` / `--dry-run --json`  | 预览官方选中的测试文件；JSON 只包含测试清单                                           |

任务开始记录一次 HEAD SHA；任务结束使用该起点。开始前已有未提交改动全部纳入；不保存或扣除初始 patch。官方 changed 使用 Git 的三点比较和当前未提交文件，合并带入的改动正常参与选择，不做来源过滤或额外净差异运算。

Push 要求已暂存、未暂存、未跟踪改动均为空（忽略 Git 已忽略的文件）。不干净时非零退出，不自动 stash 或创建 checkout，保证执行内容就是推送版本。hook 非删除 ref 必须指向当前 HEAD；多个 ref 通过各自基线调用官方选择，再合并精确测试规格。删除 ref 无需测试。手动 push 模式没有 hook 输入时使用 upstream；没有有效 upstream 时使用 origin/staging 的 merge-base。不存在可用基线、需要使用的 remote SHA 无效、目标不是 HEAD 均非零退出。显式基线优先于 hook remote SHA；未提供显式基线时，新分支基线只使用 origin/staging，不猜测其他分支。

所有模式的基线优先级均为 `--base` → `ZCODE_AFFECTED_TEST_BASE` → `ZCODE_PRE_PUSH_BASE` → 场景默认基线。`ZCODE_AFFECTED_TEST_BASE=<ref> git push` 使用指定分支、tag 或 commit 的已解析 SHA 交给 Vitest changed；不把 staging 等分支名写死。即使指定基线，Push 仍须工作区干净且非删除目标是 HEAD。显式基线无效时报错，不回退到 remote SHA。

默认工作区没有显式基线时不读取 upstream。--files / --files-manifest 使用官方 related，不与 --base 或 push 混用。

### 选择与执行

```text
场景与基线 → Push 工作区检查 → Vitest 官方选择 → 与完整根 UT 规格比较
                                                     ├─ 0 个：说明，exit 0
                                                     ├─ 部分：执行同一份规格清单
                                                     └─ 全部：说明原因，跳过 UT，exit 0
```

- 粒度为测试文件；选中文件后执行文件内全部 case。根配置包含的项目构成整个根 UT 套件，排除 desktop E2E，不含 CLI 独立测试；scripts 下的 Node 原生测试另用 node --test，不自动关联。
- 使用公开 getRelevantTestSpecifications 选择；globTestSpecifications 提供完整清单。预览只转换模块，不 collect/import 测试；执行使用同一 Vitest 实例和同一份精确规格，避免 CLI 文件名子串匹配扩大范围。
- 官方 forceRerunTriggers 保留默认配置，补充配置文件模式 `**/{vitest,vite}.config.*`（当前默认 glob 尾部 `/**` 未匹配部分配置文件），再加入公共 vitest.setup.ts。原因：官方模块依赖分析不会额外纳入 setupFiles；公共 setup 改动必须作为全量影响，由入口说明并跳过 UT，成功退出。 managed worktree 的绝对路径可能经过 `.codex` 等隐藏目录，官方 glob 默认不穿过隐藏祖先；补充模式必须以实际 root 的字面量路径为前缀，转义目录名中的 glob 元字符并将 Windows 分隔符规范为 `/`。默认模式保持不变，只补 root 内的配置/公共 setup 触发，不让普通业务文件变为全量。真实官方 API 回归同时覆盖隐藏根、特殊目录名、Windows 路径、相似目录拒绝和业务文件部分选择。
- 全量指选中完整套件（按 project/pool/path 识别规格），不是任意数量阈值。大量真实关联测试若未覆盖完整套件，照常运行。即使是 dry-run / JSON，选中整个非空套件说明后成功退出，不因此阻止 Push。
- 无选中测试说明后 exit 0；这不代表所有改动已验证。官方依赖识别的限制照常适用，不增加字面量文件读取、类型依赖、删除文件基线等自建补偿。
- 选择精度靠准确的模块图，不靠选择规则：官方选择是文件级传递闭包，经由 barrel 的 `export *` 会把一个模块的改动传给所有导入 barrel 的测试。高扇入的纯常量模块因此只走子路径，不进根 barrel。`packages/shared/src/test-ids.ts` 的常量只从 `@zcode/shared/test-ids` 导入，根入口不再 re-export，从根入口导入这些常量会被 typecheck 拒绝；工作流一族 `test-ids-workflow.ts` 仍由根入口导出，不在本规则内。原因：根入口由 100 多条 `export *` 汇总，改 test-ids 曾选中 1379/2638 个测试，其中直接引用 test-ids 的约 50 个。
- 测试失败 exit 1；Git、参数、基线、Vitest 错误以及脏工作区 exit 2；全量跳过 exit 0，不代表测试通过。绝不自动回退全量、追加全量重试或静默吞掉选择器异常。pnpm test / pnpm test:unit 保持显式全量入口。
- 输出选中数量与基线；跳过全量时说明官方选中整个套件，列出官方 related 改动文件。dry-run 列精确规格，JSON 包含 runner/project/pool/path，不伪造逐文件关联原因。
- Git/文件操作异步；保留 hook local env 清理和 lint-staged JSON manifest，Windows 不经 shell 展开文件名。不修改工作区和 index。

全量跳过适用于工作区、任务结束、Push 和显式文件入口。Push 的 lint、架构、脏工作区、基线及实际局部测试失败仍会阻止推送；跳过全量只放行 affected UT 这一项，不代表测试已通过。

### 回归验收

使用临时 Git 仓库、真实 Vitest 和命令入口验证：局部选择与预览/执行一致、未选择文件不执行、任务跨 commit 与旧 WIP、新增测试、配置与公共 setup 全量跳过、共同依赖全量跳过、真实 git push 在全量跳过后成功推送、无关联成功退出、测试失败、无效基线、首次/已有分支 Push、脏工作区和非 HEAD 推送阻止、多个 ref 与删除 ref、集成合并正常参与选择、lint-staged manifest 和 Git local env 隔离。夹具移除外层 push/基线环境后再注入本场景参数，避免真实仓库 SHA 污染临时仓库。

### 时序与真实子进程测试

- 计时算法用受控时钟和数据事件验证先后顺序；真实 IO 接线保留独立集成覆盖，不把进程启动排队计入很短的算法测试窗口。
- 真实子进程的关闭测试先等待夹具在注册退出处理器后发出的 ready 事件，再开始关闭计时；固定 sleep 不能证明子进程已就绪。
- 必须在短窗口内启动独立 Node、显示服务进程树或原生依赖的集成测试，放入 `vitest.config.ts` 的 `fork-isolated` 组。该组在普通测试后按单文件串行执行；保留真实进程、原断言和超时值，不跳过用例。
- 远控前端选源的 CI shell 集成测试会连续启动 Git、Bash 和 Node，归入上述串行组，保留真实选源、构建接线、清理验证和原 30 秒超时。
- 原生文件监听的集成测试也在串行组验证真实事件送达；通知去重与事件顺序使用受控 watcher 事件单独验证，避免把逻辑断言绑定到系统事件的调度时机。Gen UI 状态覆盖外部写入、重复文件事件、同值写入 ACK，以及读取最新状态后仍能收到通知。
- 正常完成同时断言退出码、`timedOut: false` 和 `aborted: false`。取消或截止不能把信号退出当作成功；资源清理断言应确认只移除本次创建的资源。

```text
普通 unit（受控事件/时钟） → fork-isolated（真实进程，单文件串行）
                                     └─ 正常结束 / 取消 / 截止 → 核对状态与资源清理
```

### CLI 原生测试环境

affected 只选择根 Vitest UT，工具 Node 测试另行执行，不代替 CLI 的原生 `pnpm --filter zcode-cli test`。CLI 的 CUA 同步测试使用明确传入的 `ZCODE_CUA_REPO` 定位 producer checkout，Turbo 的 test task 将其计入缓存键并传入测试；不记录本机绝对路径，不更改 producer pin。`VITEST_MAX_WORKERS` 同样传入并参与缓存键，资源受限的全量验证可显式限制单套件并发，不能靠扩大超时掩盖断言失败。

CLI 全量入口通过 pretest 构建根 workspace 的 `@zcode/model-option-map`，确保 SEA 测试从干净 checkout 也能读取运行时资源；不能依赖先前手动构建的 dist。
