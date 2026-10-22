# 本地暂存箱（平台通用件）

**一句话**：agent 产出、还没报出去或还没定稿的东西，统一放进**一个标准位置**，
人和 agent 之后都能找回来。跟具体业务无关——任何 skill 都能用。

为什么要有它（2026-10-19 用户提出）：草稿以前各 skill 自己找地方放（`/tmp`、工作区里随手一个文件名），
而卡片上的「暂存」按钮只能在本机记一笔（沙箱写不了文件），于是"我上周暂存的那份呢"没人能回答。
抽到平台层之后，**"暂存"＝文件已经在暂存箱里**，不需要按钮替谁记账，agent 也随时查得到。

实现：`skills/_platform/drafts.mjs`（唯一的写入与读取口）。

## 一、放在哪

解析顺序（第一个可用的生效）：

1. `UWORK_DRAFTS_DIR`（测试与特殊机器用）
2. `<ZCODE_STORAGE_DIR>/drafts`（桌面 dev 实测＝`~/.uwork/drafts`）
3. `~/.uwork/drafts`（兜底）

位置在**用户级**，不是工作区：换项目、换会话都还在，也不会污染 git 仓库。

## 二、长什么样

```
<root>/<id>/
  draft.json     # 信封：类型 / 标题 / 状态 / 时间 / 标签 / 备注
  payload.json   # 业务内容（由 skill 自己解释，平台不解释）
```

`<id>` ＝ `yyyymmdd-hhmmss-<类型尾段>`（如 `20261019-084829-draft`）：按时间排序天然有序，人也读得懂。

信封（`draft.json`）：

| 字段                                      | 说明                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `version`                                 | 契约版本（当前 1）                                                                         |
| `kind`                                    | 业务类型，`^[a-z0-9][a-z0-9.-]{0,63}$`（如 `dept-qa-report.draft`）                        |
| `title`                                   | 人认东西靠它，必填                                                                         |
| `status`                                  | **只有三态**：`staged`（还没报出去）/ `submitted`（报了，带业务编号）/ `dropped`（不要了） |
| `createdAt` / `updatedAt` / `submittedAt` | ISO 时间                                                                                   |
| `submission`                              | 报出去时记的业务编号（如工作项 id）                                                        |
| `tags` / `note`                           | 可选                                                                                       |
| `payload`                                 | 有业务内容时是 `payload.json`                                                              |

## 三、怎么用

```bash
# 暂存（草稿一写出来就做，别等到用户点暂存）
node skills/_platform/drafts.mjs stage --kind dept-qa-report.draft \
  --title "第 43 周配置项测试记录" --payload /tmp/qa-draft.json --tags qa,2026-W43

# 找回（agent 回答"我暂存过什么"就靠它）
node skills/_platform/drafts.mjs list                       # 默认只列 staged
node skills/_platform/drafts.mjs list --status all --limit 10
node skills/_platform/drafts.mjs show <id>

# 收尾
node skills/_platform/drafts.mjs submit <id> --item <业务编号>   # 报出去了
node skills/_platform/drafts.mjs drop <id> --reason <原因>       # 不要了
node skills/_platform/drafts.mjs prune                            # 只清 dropped
```

## 四、三条纪律

1. **`stage` 是"已经暂存"，不是"准备暂存"**：草稿写出来就入箱，之后用户点不点卡片上的「暂存」都无所谓
   ——那个按钮只表示"留着"，**不需要它替谁记账**（沙箱里也写不了文件）。
2. **业务内容放 `payload.json`，平台不解释**：字段含义、模板校验、审核人路由都是各业务自己的事；
   暂存箱只负责"在哪、什么状态、什么时候"。这样新增业务不用改平台。
3. **只写自己的根目录之内**：id 与 kind 都过白名单校验，任何穿越路径的输入直接拒（退出码 2）；
   平台也不会替 skill 删 `staged` 的记录——**没报出去的东西不能悄悄消失**。
