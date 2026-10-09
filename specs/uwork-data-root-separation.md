# UWork 独立数据根（与 ZCode 分离）

## 决策（2026-10-05）

UWork 使用自己的用户级数据根，**不迁移**上游 ZCode 的任何既有数据：首次启动即为空目录，用户按需重新登录与配置。

- 数据根：`{dataBaseDir}/.uwork`（`getUWorkDataRootDir()`）。app 配置目录为 `{dataBaseDir}/.uwork/v2`，包含 setting.json、credentials.json、provider_config.json、sessions、tasks-index、logs、crash、certs、enterprise-identity.json、ucas-gateway.json、checkpoints、feedback 等。
- 覆盖变量：`UWORK_DATA_BASE_DIR` 优先；`ZCODE_DATA_BASE_DIR` 仅作旧脚本兼容回退。
- 设置启动目录：`{用户主目录}/.uwork/v2/setting.json`（`settingService.getSettingsDir()` 与数据根同名）。设置在数据根覆盖生效前读取，因此必须落在同一命名空间。
- Electron 运行时身份：应用名与 userData 目录统一为 `UWork` / `UWork Dev` / `UWork Preview`；不再复用 `ZCode*` 目录，浏览器 profile 与单实例锁与上游分离。
- Agent/CLI 用户级存储：Host 下发 `ZCODE_STORAGE_DIR={dataBaseDir}/.uwork`（用户显式设置时不覆盖）。**所有用户级路径都必须经 `@zcode/shared` 的 `resolveUserStorageRoot()` / `resolveUserCliRoot()` / `resolveUserCliConfigPath()` 解析**（2026-10-08 补），包括 CLI 用户配置 `config.json`（插件启用、MCP、技能开关）、`db`、`log`、`debug`/`rollout`、`workflows`、用户技能根与桌面侧插件同步根；未下发 storage root 时回落上游 `~/.zcode`。
- 用户内容的归属规则：两个产品共享的约定（`~/.agents/skills`、`~/.agents/mcp.json` 等）留在原处；UWork 自己读写的用户级内容（原生技能根、用户命令、全局 workflow、插件镜像、MCP 用户配置）落 `{dataRoot}` 下，不再读写 `~/.zcode` 对应目录。
- **桌面主进程**（启动早于设置服务，不能 import 服务侧 helper）：统一走新增的 `packages/desktop/src/main/desktopHomePath.ts`（`resolveDesktopHomePath` / `resolveDesktopDataRootDir` / `resolveDesktopCliDir` / `resolveDesktopSettingsFile` / `resolveDesktopPluginsDir`，基准优先级 `UWORK_DATA_BASE_DIR` > `ZCODE_DATA_BASE_DIR` > `ZCODE_DESKTOP_HOME_DIR` > `HOME`）。已改用的点：**MCP 用户目录**（`mcpUserDirectory`，`<dataRoot>/cli/config.json` —— 这是真正持久化 MCP 服务的路径）、硬件加速与数据根 bootstrap 读的 setting.json、`index.ts` 的窗口设置文件、诊断导出（`exportLogs` 的 CLI 目录与日志包内标签、Computer Use run 目录）。

## 边界

- 不做任何复制或迁移：`~/.zcode` 与 `~/.uwork` 互不影响；升级 UWork 不读取旧根，也不删除旧根。
- 仓库内的工作区级 `.zcode/` 约定（`AGENTS.md`、`config.json`、`agents/`、`workflow-runs/` 等）属于项目内容，不是用户级数据根，保持不变。
- 已知未覆盖：远端 SSH 主机上的 `~/.zcode/tmp/prompt-attachments` 等路径仍保持上游默认，待远端 Agent env 一并下发后切换。
- ~~CLI 用户配置文件不跟随数据根~~ **已于 2026-10-08 修复**：此前 `plugins.enabledPlugins`（插件启用）与 `mcp.servers`（MCP 服务）写在 `~/.zcode/cli/config.json`，而插件缓存/市场状态在 `~/.uwork/cli/plugins/`。现在两侧统一走 storage root：CLI 侧 `file-config.adapter.getDefaultConfigPath()`、会话 DB、日志目录、debug/rollout、用户技能根（`adapters/src/skills/roots.ts`）、全局 workflow（`saved-workflows`、`script-workflow-*`）、debug server 的默认源；桌面侧 `skillsService`、`pluginSyncService`、`settingsSyncService`、`commandsService`、`subagentsService`/`subagentStorage`、`node.ts#hasGlobalCliZCodeCuaServer` 全部改用 `services/src/paths.ts` 的 `getUworkUserCliConfigPath()` / `getUworkUserPluginsRoot()` / `getUWorkDataRootDir()`。存量已迁移（UWork 拥有的两个键搬入 `~/.uwork/cli/config.json`，ZCode 自己的条目原样留在原文件，原文件留 `.bak-*` 备份）。

## 验收

- 自动化验收入口为 `scripts/test/uworkBranding.test.ts`，由桌面发布 CI 的行为测试步骤执行。Desktop Main 的 `desktopRuntimeEnv` 唯一负责 Electron 应用名、userData 与 sessionData；服务路径 API 唯一负责用户级数据根；测试不增加目录写入或迁移逻辑。
- Node 测试执行源码中的运行时身份与路径初始化声明，以 Electron appData 为受控边界：正式、开发、预览模式分别返回 `UWork`、`UWork Dev`、`UWork Preview`，默认 sessionData 为对应 userData 下的 `session`，均不落入 `ZCode*` 目录。
- 保留既有显式覆盖接口：`ZCODE_DESKTOP_APPLICATION_NAME`、`ZCODE_DESKTOP_USER_DATA_DIR`、`ZCODE_DESKTOP_SESSION_DATA_DIR` 优先于默认值；启用 `ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA` 时不覆盖 Electron 默认目录，显式 userData 仍优先。
- 每个独立子进程通过服务公开路径 API 验证默认根、`UWORK_DATA_BASE_DIR` 优先级、空值回退与 `ZCODE_DATA_BASE_DIR` 兼容回退，配置目录必须为所选数据根下的 `.uwork/v2`。辅助程序安装文件名和工作区内 `.zcode/AGENTS.md` 的兼容性断言继续保留。
- 全新环境启动 UWork 后只创建 `~/.uwork`（或 `UWORK_DATA_BASE_DIR` 指向的目录）与 `~/Library/Application Support/UWork*`；`~/.zcode`、`~/Library/Application Support/ZCode*` 的 mtime 不因 UWork 运行而变化。
- 设置、凭据、供应商配置、会话、日志、企业身份与网关状态全部落在 UWork 根内；重启后仍从新根读取。
- 本机实测（2026-10-05）：以产品默认根启动 dev 实例，`~/.uwork/v2` 首次创建（setting.json `recentProjects: []`），扫码登录后 credentials/provider_config/ucas-gateway 均写入新根；同一时段 `~/.zcode/v2/setting.json` 的写入来自同时运行的上游 ZCode.app，UWork 日志中的设置写入路径只有 `~/.uwork/v2/setting.json`。
- 本机实测（2026-10-08，用户配置文件迁移后重启）：迁移前把 UWork 拥有的两个键搬进 `~/.uwork/cli/config.json` 并记录 `~/.zcode/cli/config.json` 的 mtime 与 sha256；重启 dev 实例并打开插件商店/管理已安装后，
  - `~/.zcode/cli/config.json` 的 mtime 与 sha256 **保持迁移时刻不变**，`~/.zcode/cli/` 下近 3 分钟的新文件只有本机 ZCode 会话自己的 db/log/rollout/artifacts；
  - 新实例读到的是 UWork 根：`kb-search@ucas-aihub` 在「管理已安装」里显示为启用（该键已从 ZCode 配置里删除，只能来自新根）；
  - 应用日志出现 `[mcpStore] loadMcpFromUserDirectory`（MCP 用户目录读取路径已走新根），`ucas-rag` 服务器条目位于 `~/.uwork/cli/config.json`；
  - `~/.uwork/cli/` 下出现 `config.json`、`log`、`debug`、`exec`、`plugins`，即日志目录等也已随 storage root 落位。
- 迁移带来的行为变化（有意为之）：UWork 的用户技能根从 `~/.zcode/skills` 变为 `~/.uwork/skills`（`.agents/skills` 仍共享）。迁移当时 UWork 可见 `~/.agents/skills` 的 9 个技能，`~/.zcode/skills` 的 10 个不再出现在 UWork；需要的话把它们拷进 `~/.uwork/skills/` 或从公司技能市场重新安装。
- **全新环境实测（2026-10-08）**：用临时基准目录起全新实例 —— `UWORK_DATA_BASE_DIR=/tmp/uwork-fresh/home`、`ZCODE_DESKTOP_HOME_DIR=/tmp/uwork-fresh/home`、`ZCODE_DESKTOP_USER_DATA_DIR=/tmp/uwork-fresh/userdata`（dev 运行时还需 `scripts/desktop-enterprise-identity.ts stage` 那份公开企微配置，否则登录页显示「暂未配置」）。结果：
  - `{临时 home}/.uwork/v2` 与 `.uwork/cli` 从零创建；**`{临时 home}/.zcode` 未被创建**；登录后自动配置的密钥、装的 `kb-search@ucas-aihub`（启用状态写在 `.uwork/cli/config.json`）都在临时根内。
  - 真实侧 `~/.uwork`、`~/.zcode` 的 mtime 与 sha256 全程不变。
  - **这一轮抓到了第一版迁移的漏项**：桌面主进程的 MCP 用户目录仍按 `homedir()/.zcode` 解析，导致在「HOME 未变、仅数据根被重定向」的环境里，MCP 被写进真实 `~/.zcode/cli/config.json`（按名字审计 `packages/desktop/src/main/*.ts` 时漏了子目录）。补上 `desktopHomePath.ts` 后复测：MCP 写入落 `<临时数据根>/cli/config.json`，真实两份配置的 hash/mtime 不变。
- 仍保留的 dev 专属例外：`desktopRuntimeEnv.ts` 里「未签名 CUA helper」的默认查找路径仍指 legacy home（仅当开发者显式打開 `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL` 时生效，且可用 `ZCODE_CUA_BUNDLED_HELPER_APP_PATH` 覆盖；不落盘任何状态）。

## 审查修复契约（2026-10-09）

运行时数据根由 services 的 bootstrap 初始化持有；Desktop MCP 在初始化后通过公开路径 API 读取该根。启动 setting.json 仍固定在 bootstrap home，不使用运行时根反推。CLI storage root 独立于 v2：显式 ZCODE_STORAGE_DIR 优先，否则为有效 dataBaseDir/.uwork；cli 兼容形式保留。服务技能、命令、子代理、插件同步、MCP 与 Agent 使用相同 storage root。

更换 dataBaseDir 复制整个 UWork 自有根（v2、cli 配置/启停状态/缓存、skills、commands、agents、plugins、workflows、workspace 等），不读取 .zcode 或共享 .agents。仅排除 v2/setting.json 及其原子写入临时文件、符号链接；迁移 JSON 中指向旧 UWork 根的绝对路径重定位到新根。显式外部 CLI storage root 不移动。

旧根 → 临时目标 → 校验文件内容 → 重定位元数据 → 原子激活目标 → 保存 bootstrap 设置 → 重启读者。旧根始终保留；复制/校验失败不切换设置。非空目标拒绝并提示选空目录，不默默丢弃目标或旧数据。源/目标嵌套拒绝。验收覆盖目标冲突、复制失败、MCP 增改删与重启、所有路径优先级。
