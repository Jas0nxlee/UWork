# UWork 独立数据根（与 ZCode 分离）

## 决策（2026-10-05）

UWork 使用自己的用户级数据根，**不迁移**上游 ZCode 的任何既有数据：首次启动即为空目录，用户按需重新登录与配置。

- 数据根：`{dataBaseDir}/.uwork`（`getUWorkDataRootDir()`）。app 配置目录为 `{dataBaseDir}/.uwork/v2`，包含 setting.json、credentials.json、provider_config.json、sessions、tasks-index、logs、crash、certs、enterprise-identity.json、ucas-gateway.json、checkpoints、feedback 等。
- 覆盖变量：`UWORK_DATA_BASE_DIR` 优先；`ZCODE_DATA_BASE_DIR` 仅作旧脚本兼容回退。
- 设置启动目录：`{用户主目录}/.uwork/v2/setting.json`（`settingService.getSettingsDir()` 与数据根同名）。设置在数据根覆盖生效前读取，因此必须落在同一命名空间。
- Electron 运行时身份：应用名与 userData 目录统一为 `UWork` / `UWork Dev` / `UWork Preview`；不再复用 `ZCode*` 目录，浏览器 profile 与单实例锁与上游分离。
- Agent/CLI 用户级存储：Host 下发 `ZCODE_STORAGE_DIR={dataBaseDir}/.uwork`（用户显式设置时不覆盖），CLI 侧读取该变量的状态落到 UWork 根。

## 边界

- 不做任何复制或迁移：`~/.zcode` 与 `~/.uwork` 互不影响；升级 UWork 不读取旧根，也不删除旧根。
- 仓库内的工作区级 `.zcode/` 约定（`AGENTS.md`、`config.json`、`agents/`、`workflow-runs/` 等）属于项目内容，不是用户级数据根，保持不变。
- 已知未覆盖：CLI 子模块内部仍有直接使用 `homedir()/.zcode` 的路径（workflows 等），未读取 `ZCODE_STORAGE_DIR`；远端 SSH 主机上的 `~/.zcode/tmp/prompt-attachments` 等路径同样保持上游默认，待远端 Agent env 一并下发后切换。

## 验收

- 全新环境启动 UWork 后只创建 `~/.uwork`（或 `UWORK_DATA_BASE_DIR` 指向的目录）与 `~/Library/Application Support/UWork*`；`~/.zcode`、`~/Library/Application Support/ZCode*` 的 mtime 不因 UWork 运行而变化。
- 设置、凭据、供应商配置、会话、日志、企业身份与网关状态全部落在 UWork 根内；重启后仍从新根读取。
- 本机实测（2026-10-05）：以产品默认根启动 dev 实例，`~/.uwork/v2` 首次创建（setting.json `recentProjects: []`），扫码登录后 credentials/provider_config/ucas-gateway 均写入新根；同一时段 `~/.zcode/v2/setting.json` 的写入来自同时运行的上游 ZCode.app，UWork 日志中的设置写入路径只有 `~/.uwork/v2/setting.json`。
