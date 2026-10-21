# 上游版本追踪

UWork 是 `zai-org/ZCode` 的定制 fork，需要同时盯住**两条轨道**——它们不总是同步：

| 轨道       | 来源                                                                  | 作用                                   |
| ---------- | --------------------------------------------------------------------- | -------------------------------------- |
| 开源快照轨 | `zai-org/ZCode` 的整树 commit/tag（上游每次发版一个 commit 覆盖全仓） | 我们合并的代码基线                     |
| 官方发布轨 | `zcode.z.ai` 的 Electron 更新 manifest                                | 用户实际能拿到的版本；可能领先公开仓库 |

工具：`scripts/upstream-track.mjs`。本文是账本与口径，合并的接缝细节见 [`upstream-sync-v3.15.1-status.md`](./upstream-sync-v3.15.1-status.md)。

## 一、当前位置（2026-10-13 实测）

```bash
node scripts/upstream-track.mjs status --fetch --ours chore/upstream-v3.15.1-sync
```

| 项                                          | 版本 / ref                                  | 说明                                                                                                               |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 官方 stable / preview                       | **3.15.3**                                  | `https://zcode.z.ai/api/v1/releases/electron/manifest?platform=darwin-aarch64&channel=1`（preview 用 `channel=3`） |
| 开源快照（最新）                            | **v3.15.1** `aac47556` 2026-10-10           | `package.json` 3.15.1、`apps/zcode-cli` 0.16.9                                                                     |
| 开源快照（上一个）                          | **v3.14.3** `29628c9a` 2026-09-24           | 我们发布线的基线                                                                                                   |
| `uwork`（UWork 主线）                       | `22a99b74` = UWork **3.16.0**（2026-10-09） | 仍停在快照 v3.14.3 代码基线                                                                                        |
| `chore/upstream-v3.15.1-sync`               | `30f68539`                                  | 已合入快照 v3.15.1，`pnpm typecheck` 全绿；分支已推 `ModestXin/UWork`，PR（WIP）未创建                             |
| `Jas0nxlee/UWork` 的 `main`（上游追踪分支） | `29628c9a`                                  | 停在 v3.14.3，落后一个快照                                                                                         |

**结论**：官方发布轨 **3.15.3** 领先开源快照轨 **v3.15.1**——3.15.2 / 3.15.3 的修复（登录鉴权失败、更新后无法退出、引导重复弹出、并行 Agent 请求异常等）**尚未进入公开仓库**。所以「合并 v3.15.1」不等于追平官方；等上游推下一个整树快照（预计直接跳到 3.15.3 代码线）后做一次**增量合并**即可，不必现在重做一遍。

## 二、快照账本

| 上游快照                 | commit     | 日期       | 我们的合并                             | 结果                                                                      |
| ------------------------ | ---------- | ---------- | -------------------------------------- | ------------------------------------------------------------------------- |
| v3.14.3                  | `29628c9a` | 2026-09-24 | 已随线发布（UWork 3.15.x/3.16.0 基线） | —                                                                         |
| v3.15.1                  | `aac47556` | 2026-10-10 | `chore/upstream-v3.15.1-sync`（WIP）   | typecheck 0 错误；单测 528 例待按裁剪口径处理；远控 UI 未移植；见状态文档 |
| （官方 3.15.2 / 3.15.3） | —          | —          | 无公开快照可合                         | 等上游发布整树快照                                                        |

## 三、怎么跑

```bash
# 位置与落后情况（含官方发布轨；退出码 0=两轨齐平，2=任一轨落后）
node scripts/upstream-track.mjs status --fetch
node scripts/upstream-track.mjs status --fetch --ours chore/upstream-v3.15.1-sync --tracking origin/main

# 快照之间的三方比对（base=上一快照，upstream=新快照，ours=我方分支）
node scripts/upstream-track.mjs diff --fetch --ours uwork \
  --json /tmp/upstream-diff.json --conflicts /tmp/upstream-conflicts.txt
```

`status` 只做哈希级比对，不读文件内容：partial clone（`--filter=blob:none`）上也是秒级。`--no-official` 可跳过官方轨查询（纯离线），`--platform` / `--endpoint` 可改官方 manifest 的查询目标。

### 八分类口径

| 分类         | 含义                                           | 合并动作               |
| ------------ | ---------------------------------------------- | ---------------------- |
| 一致         | 三方同哈希（含双方都删、双方各自新增同一内容） | 无                     |
| 上游单方改   | 我方 == 旧快照，上游变了                       | 可直拿候选             |
| 上游新增     | 旧快照没有、上游有、我方没有                   | 直接加入               |
| 双方都改     | 三方两两不同                                   | **真冲突面**，逐个人工 |
| 我方单方改   | 上游 == 旧快照，我方变了                       | 保留我方（定制）       |
| 我方独有     | 只有我方有                                     | 保留                   |
| 上游有我方无 | 上游有、我方没有（旧快照也没有）               | 我方有意裁剪？需确认   |
| 上游删我方留 | 旧快照有、上游删了、我方还在                   | 确认是否接受删除       |

「源码类」= 代码扩展名（`.ts/.tsx/.js/.mjs/.py/...`）且不是生成物（lock、`dist/`、`THIRD-PARTY-NOTICES.md`、`third-party/inventory.json`）。

## 四、坑与规矩

1. **上游 tag 必须抓进独立命名空间**：UWork 自有发版 tag 与上游同名（`v3.14.3`…`v3.15.x` 两边都有，含义不同）。直接 `git fetch --tags` 会互相覆盖，且 `git fetch` 会报 `would clobber existing tag`。脚本用 `+refs/tags/*:refs/upstream-tags/*`，因此凡引用上游 tag 一律走完整 ref（`refs/upstream-tags/v3.15.1`），裸名会被本地同名 tag 抢走。
2. **不要用 `git ls-tree -r -l`**：它要读 blob 大小，会在 partial clone 上懒加载 1.6 万文件、几十 GB。分类只要 mode/type/hash，用不带 `-l` 的输出。
3. **整树快照语义**：上游每次一个 commit 替换全仓，所以「文件不同」只说明谁动过，不能判断新旧；必须做三方（旧快照 / 新快照 / 我方）比对，不能把上游某一侧整体照抄。
4. **官方发布轨不进代码**：它只回答「用户手上的版本有没有我们缺的修复」。要拿到官方包内容只能靠下载安装包，不用于合并。发版号是两条线：UWork 自己的 `3.16.x` 与上游 `3.15.x` 无对应关系，别当成矛盾。
5. **合并时的既定做法**（详见状态文档）：`package.json` 走 JSON 三方合并（依赖取并集、我方钉死版本优先）；`ZCode→UWork`、`~/.zcode→~/.uwork` 的改名映射从 base→ours 词级 diff 推出后套回上游新文本；我方**有意裁剪**的产品文件（侧栏、Root、帮助菜单等）取我方版本；被上游新代码引用的、我们裁掉的上游模块逐个从上游恢复。推 WIP 分支时 `pnpm verify:pre-push` 会拦（lint/单测），用 `git push --no-verify` 并在 PR 里说明。
6. **追踪分支同步**：`Jas0nxlee/UWork` 的 `main` 是纯上游镜像，落后时从 fork 提「纯快进、无冲突」的 PR 到 `Jas0nxlee:main`（上游历史 v3.14.3 → v3.15.1 是快进关系，已核实）。

## 五、相关

- [`upstream-sync-v3.15.1-status.md`](./upstream-sync-v3.15.1-status.md)：v3.15.1 合并的完成项、遗留项与需要产品决定的三处。
- `docs/upstream/`：针对上游行为的调研笔记（如 MCP SDK 探测响应问题）。
- 脚本内注释（`scripts/upstream-track.mjs` 文件头）是参数的唯一来源。
