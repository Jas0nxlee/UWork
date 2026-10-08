# UWork GitHub 多平台发布

## 发布规则

- 发布目标为用户 fork `Jas0nxlee/UWork`，默认分支 `uwork`；正式客户端身份为 `UWork` / `dev.zcode.app`，构建显式使用 `ZCODE_ENV=production` 和 `ZCODE_PREVIEW_IDENTITY=0`。
- 首次配置以 `v3.14.4` 发布，版本由根 `package.json` 提供。已有标签不移动，不覆盖其他版本的 Release。
- 本轮修复以 `v3.14.5` 发布：登录恢复与取消、子进程崩溃归类、Linux 历史桌面项、UCAS 验收地址及发布 tag 门禁。Release 说明列出用户可见修复与仍需每台设备单独放置的企业身份公开配置。
- 下一版 `v3.14.7` 修复新设备企业微信按钮禁用：五个平台构建均从 GitHub Actions 加密配置注入默认公开参数，随包资源必须通过严格字段校验和内容一致性校验。安装后无需复制配置文件；保留本机覆盖与用户凭据隔离，并发布本次 UCAS Key 引导。`v3.14.6` 构建因新增 Linux 启动测试误用可执行文件名而未发布，标签保留。
- 本次发布为 `v3.15.0`：包含企业网关自动配置、套餐/用量展示、独立 UWork 数据目录、目录规则测试与依赖安全修复。根版本是唯一版本所有者；发布说明从 `docs/releases/<version>.md` 读取，不继续复用上一版硬编码的变更说明。缺少当前版本说明时汇总失败，不发布。
- `v3.15.0` 升级说明必须明确：用户级数据改为 `~/.uwork`，不迁移或删除 `~/.zcode`；首次升级可能需要重新登录与配置。未保存 issuer 的历史 MCP OAuth 凭据刷新时需重新授权。调试 forge 固定到尚未正式发布的上游安全修复提交；历史许可原文缺口保持待复核标记，不声称材料已经全部核验完成。
- `v3.15.0` 未公开发布：干净环境的共享 `node_repl` 主机构建引用未声明的旧 MCP SDK 类型而失败。保留该标签，修正版使用 `v3.15.1`；Computer Use bridge 的 `CallToolResult` 从主机已声明的 `@modelcontextprotocol/server` 公共入口读取，不恢复旧 SDK 或依赖 hoist。桥接协议、能力令牌、工作区身份和代际校验保持原实现。检查阶段新增完整桌面 Agent 构建，覆盖 CLI 依赖顺序、主机类型与 runtime 产物，在进入平台打包前拒绝缺失模块。
- `v3.15.1` 产物校验发现新 ASN.1 依赖的 `pvtsutils` 未进入 app.asar：打包注入与最终校验维护了不同闭包根清单。保留该标签，发布版本改为 `v3.15.2`；两阶段统一消费 `desktop-asar-runtime-modules.mjs` 的唯一不可变清单，使用现有递归依赖解析，不逐个手工补叶子包。移除无用的 forge 注入根，保留 telemetry、ZIP、SSH 与 updater 的既有边界。CI 使用真实 ASAR 注入/解包及隔离 Node 进程验证 ASN.1 库能解析和加载，禁止靠工作区 hoist 掩盖缺包。
- 包根解析必须略过仅声明 `type=commonjs` 的内部 package.json，向上找到具名包根，保留真实 exports 和依赖声明；不能把 `build/cjs` 或 `umd` 当成整个包复制。
- `v3.15.3` 修正 macOS DMG 的遗留品牌背景：普通与 Retina 素材均显示 `UWORK`，保持原安装拖拽布局。发布后核对实际 macOS arm64/x64 DMG 内的 `.background.tiff` 与本次素材一致；不覆盖已经公开的 v3.15.2 文件。
- 隔离启动测试与正式打包共用 `resolveDesktopProductIdentity` 的程序名；Linux 的兼容内部程序名保留，不依据可见 UWork 品牌猜测路径。
- `uwork` push / PR 执行 lint、typecheck、架构与相关服务测试；版本标签或手工工作流执行五个原生构建：macOS arm64/x64、Windows x64、Linux x64/arm64。Node/pnpm 分别遵循 `mise.toml` 和 `packageManager`，Actions 固定完整提交 SHA。
- 构建复用现有 `bundle.mjs`。桌面安装包不依赖远程 mock CDN，CI 使用 `ZCODE_SKIP_REMOTE_ASSETS=1`，保留本地 Agent、插件、原生搜索工具、依赖闭包和平台校验。依赖和 Electron 从公开官方来源获取；随包企业身份配置仅接受公开字段，个人凭据不进入产物。
- macOS 输出 DMG/ZIP，Windows 输出 NSIS EXE，Linux 输出 AppImage/DEB/RPM/Arch 包。公开 CI 无开发者证书时使用明确启用的 macOS ad-hoc 签名并验证资源封印；不声称具有 Apple 公证或 Windows 发布者签名。
- macOS 的 ad-hoc 打包在签名前清理 appOutDir 中的 Finder/resource-fork 扩展属性；只处理当前生成的应用副本，不修改用户数据或原有安装。
- Linux 包保留发行格式的架构名称：x64 可为 x64/x86_64/amd64，arm64 可为 arm64/aarch64；manifest 使用统一 matrix 身份，汇总须识别对应别名。
- 按用户选择，正式发布的依赖审计必须拒绝 high/critical，上传完整审计报告。不为本次发布配置审计忽略项或允许失败。

## 所有者和事件顺序

- 根版本和 Git 提交唯一决定构建身份。平台 build job 只产生当前提交的安装包与带 SHA256 的 manifest；publish job 唯一拥有 Release 创建与公开操作。
- publish 必须等待检查、审计策略和全部五个平台构建完成。汇总时重新验证版本、提交、平台矩阵、必需文件和校验和；任一目标失败不发布完整 Release。
- 构建 job 仅有 contents read；publish job 才有 contents write。输入先校验，再通过环境变量和独立脚本传递，不把用户输入插入 shell 代码。
- 发布先创建 draft，再上传全部已核验文件，最后公开；重跑只能补齐同一版本、同一提交的 draft。已公开 Release 不自动覆盖。保留旧版本和本机替换前的 `.app` 备份作为回退路径。
- 手工 publish 只允许从 `uwork` 分支的当前提交执行。版本 tag 必须在发布前存在且精确指向当前提交；publish job 不创建或移动 tag。tag push 也必须满足 tag 与根版本一致、指向当前提交。

```mermaid
flowchart LR
  Commit[版本和不可变 Git 提交] --> Check[类型 / lint / 架构 / 服务测试]
  Commit --> Audit[依赖审计及发布策略]
  Check --> Mac[macOS arm64 / x64]
  Check --> Win[Windows x64]
  Check --> Linux[Linux x64 / arm64]
  Mac --> Validate[校验五平台 manifest 和 SHA256]
  Win --> Validate
  Linux --> Validate
  Audit --> Validate
  Validate --> Draft[创建并上传 draft]
  Draft --> Release[公开 GitHub Release]
```

## 验收

1. 五个平台 workflow 实际运行成功，Release 包含所有必需格式、源码提交和 SHA256SUMS。
2. 文件被修改、缺少目标、版本或提交不一致时，汇总脚本失败且不发布。
3. macOS 安装副本的签名、版本和源码提交通过核验，主进程实际启动；Windows/Linux 分别记录构建及可用的运行验证，不能用 macOS 启动代替它们。
4. CI 的未执行、失败、依赖审计发现和签名限制如实记录。
5. 从其它分支手工 publish、缺失 tag、tag 指向另一提交或版本不一致均在创建 Release 前失败。
