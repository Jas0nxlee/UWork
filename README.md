<div align="center">
  <img src="packages/desktop/build/uwork.svg" alt="UWork" width="96" height="96" />
  <h1>UWork</h1>
  <p>使用自己的模型服务，在同一个工作区中处理日常任务与代码开发。</p>
  <p>简体中文 · <a href="README.en.md">English</a></p>
  <p><a href="https://github.com/Jas0nxlee/UWork/tree/uwork">源码</a> · <a href="LICENSE">Apache-2.0</a></p>
</div>

UWork 是基于 [zai-org/ZCode](https://github.com/zai-org/ZCode) 定制的 AI 工作台。当前版本预置 UCAS 模型供应商，支持自定义模型服务、助理 / 开发模式切换，以及可跳过的企业微信身份登录。原智谱 / Z.ai 模型账号与内置套餐入口已移除。

本仓库由 fork 维护者独立维护，并非上游官方发行版。**默认分支为 `uwork`**，`main` 保留上游代码，便于后续比较和同步。

## 当前功能

| 功能            | 说明                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| UCAS 默认供应商 | 首次启动预置六个模型，名称、连接地址和 Chat Completions 格式固定；可编辑 API Key、模型参数与启停状态，并自动获取模型。    |
| 自定义模型服务  | 解锁添加入口后，可配置 Base URL、API Key 和 API 格式，支持 Chat Completions、Responses、Anthropic Messages。              |
| 自动获取模型    | 从供应商读取模型 ID，去重后批量添加；已有模型的参数、启停状态和顺序保持不变。                                             |
| 模型参数编辑    | 编辑上下文窗口、输出上限、输入类型及推理选项；已修复导入模型后保存参数时漏传版本号的问题。                                |
| 助理 / 开发     | UWork Logo 右侧显示当前模式，点击同一个按钮切换，选择会被记住。助理侧重过程摘要与结果，开发展示更多代码、命令和修改细节。 |
| 企业微信身份    | 桌面登录卡片内扫码，可跳过；认证后在 UWork 字标下显示姓名。同一设备各窗口共享企业账号，工作区和未提交草稿仍由各窗口管理。 |
| 工作区与任务    | 保留项目、会话、文件、终端、Git，以及插件、MCP、技能和子智能体等上游能力。                                                |
| 定制界面        | UWork SVG 字标与 U 图标、UCAS 渐隐背景、深浅主题；右上角帮助菜单仅保留资源管理器。                                        |

模式切换只改变界面呈现，不改变工具权限或模型服务权限。官方自动更新已停用，更新本定制版需要重新构建安装。

## 配置模型并开始使用

1. 启动桌面应用；如不使用企业身份，点击 **跳过登录，继续使用**。
2. 打开 **设置 → 模型设置**，选择默认的 `ucas` 供应商并填写自己的 API Key。该供应商的名称、Base URL 和 API 格式固定，不能删除；升级时会同步随包连接配置并保留密钥和已有模型参数。
3. 点击 **自动获取**，或通过 **添加模型** 手动输入模型 ID。
4. 按服务商实际能力调整模型参数，再在聊天窗口选择供应商和模型。UCAS 的六个默认模型及自动获取的新模型预设 1M 上下文、文本 / 图片输入和 `low` / `high` / `max` 推理等级；这些是客户端配置默认值，实际能力以服务端为准。

### 使用其他模型供应商

**添加供应商**初始呈灰色。在同一次打开模型设置期间，连续点击该按钮 **20 次**即可解锁，再点击一次打开模板选择器；解锁前点击其他区域会清零计数，离开并重新打开模型设置需重新解锁。这是界面规则，不是权限控制。

选择模板或创建自定义供应商后，填写服务商提供的**完整 API Base URL**、对应 API 格式及 API Key，再获取或添加模型。

以下为虚构地址示例，使用时替换成自己的服务地址：

| API 格式           | Base URL 示例                | 对话请求路径           |
| ------------------ | ---------------------------- | ---------------------- |
| Chat Completions   | `https://api.example.com/v1` | `/v1/chat/completions` |
| Responses          | `https://api.example.com/v1` | `/v1/responses`        |
| Anthropic Messages | `https://api.example.com/v1` | `/v1/messages`         |

模型列表可访问，不代表每个模型都能执行推理或支持工具调用。请以服务商文档、权限与一次实际对话结果为准。

### 自定义供应商的 Base URL

当前自动获取会为根地址尝试 `/v1/models`，但**不会把探测出的 API 前缀写回 Base URL**。如果自定义服务商实际要求 `/v1`，而配置里只填写了域名，Chat Completions 对话可能请求到网站页面，最终显示“模型未返回任何内容”。

请将自定义供应商的 Base URL 设置为服务商要求的完整 API 前缀，例如 `https://api.example.com/v1`。UCAS 随包地址已包含 `/v1`，不需要手工修改。

## 可选企业微信登录

桌面启动时，未认证用户可以在登录卡片内扫码，也可以跳过并继续使用。跳过只对当前窗口生效，重启后仍可选择登录；工作区内可通过 UWork 字标下的入口再次打开登录页，认证后点击姓名查看来源或退出。

此身份用于本地姓名展示，不引入账号数据隔离、云同步或额外操作权限。企业登录不提供模型 API Key，登录或退出也不会迁移、认领或删除已有工作区、会话与模型配置。退出清除设备上的身份会话，当前接入不承诺吊销认证服务端的 Token。

GitHub 正式安装包已携带默认企业微信公开登录参数，Windows、macOS 和 Linux 安装后可直接扫码，无需复制配置文件。扫码认证成功后，默认 UCAS 尚未配置 API Key 时会弹出可跳过的输入对话框。客户端不内置企业微信 Secret、用户 Token 或 UCAS Key；管理员可使用本机配置覆盖默认参数，位置与接口要求见 [企业微信登录对接](docs/enterprise-identity-integration.md)。该原生扫码适配器由 Desktop Local Host 加载；普通 Web 不自动启用，手机远控只展示桌面已有 Host 的身份。

## 从源码运行

当前定制版的本机构建与安装验证以 **macOS Apple Silicon** 为主。仓库仍包含 Windows、Linux、Web 与 CLI 入口；这些平台不等于已经完成相同范围的发布验收。

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**。工具版本以 [mise.toml](mise.toml) 为准；macOS 编译原生组件还需要 Xcode Command Line Tools。以下命令从仓库根目录执行。

```bash
git clone --branch uwork https://github.com/Jas0nxlee/UWork.git
cd UWork
pnpm bootstrap
ZCODE_DATA_BASE_DIR="$HOME/.uwork-dev" ZCODE_SKIP_REMOTE_ASSETS=1 pnpm dev:desktop:test
```

`bootstrap` 安装依赖、准备本机运行资源并构建相关包，默认跳过远程资源。Agent 源码已包含在 `apps/zcode-cli/` 中。

上述开发命令使用测试配置和独立数据目录，并跳过远程资源准备。环境变量写法适用于 macOS / Linux；Windows 需使用对应 shell 的环境变量语法。已安装 mise 时，也可按 [mise.toml](mise.toml) 执行 `mise install`、`mise run bootstrap` 和 `mise run dev`；其中 `dev` 任务已指定独立数据目录。

需要使用 production 服务配置时，继续指定独立数据目录：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.uwork-dev" pnpm dev:desktop
```

| 入口               | 命令                           |
| ------------------ | ------------------------------ |
| 桌面开发           | `pnpm dev:desktop`             |
| 测试环境桌面开发   | `pnpm dev:desktop:test`        |
| Web 与后端开发     | `pnpm dev:web`                 |
| CLI 源码开发       | `pnpm --filter @zcode/cli dev` |
| 准备远程工作区资源 | `pnpm bootstrap:with-remote`   |

`dev:desktop` 使用 production 服务配置；`dev:desktop:test` 使用 test 配置。这里的环境名不代表应用已经完成签名、公证或发布。

## 构建 macOS 应用

完成依赖初始化后，可以直接生成 `.app`，不依赖 DMG 包装步骤：

```bash
ZCODE_ENV=production ZCODE_TARGET_OS=mac ZCODE_TARGET_ARCH=arm64 ZCODE_SKIP_REMOTE_ASSETS=1 \
  pnpm --filter @zcode/desktop build

ZCODE_ENV=production ZCODE_TARGET_OS=mac ZCODE_TARGET_ARCH=arm64 \
  pnpm --filter @zcode/desktop exec electron-builder \
  --config electron-builder.config.js --mac --arm64 --dir
```

产物位于 `packages/desktop/dist/mac-arm64/UWork.app`。退出旧版并备份或移走 `/Applications/UWork.app` 后，可安装自己构建的应用：

```bash
ditto packages/desktop/dist/mac-arm64/UWork.app /Applications/UWork.app
xattr -cr /Applications/UWork.app
codesign --force --deep --sign - /Applications/UWork.app
codesign --verify --deep --strict /Applications/UWork.app
open /Applications/UWork.app
```

这是本机临时签名，不等同于 Apple 开发者签名或公证。上述属性清理和签名命令只用于自己构建的应用。

如需 DMG / ZIP，使用仓库的完整打包入口：

```bash
ZCODE_ENV=production ZCODE_SKIP_REMOTE_ASSETS=1 \
  pnpm bundle:desktop -- --os mac --arch arm64
```

其他平台与架构参数可通过 `pnpm bundle:desktop -- --help` 查看。完整打包与 `.app` 构建是不同步骤，某一步成功不代表其它步骤已通过。

修改应用图标时，编辑 [SVG 源文件](packages/desktop/build/uwork.svg)，然后生成原生图标资源：

```bash
pnpm exec electron packages/desktop/scripts/build-uwork-icons.cjs
```

## Web 与 CLI

`pnpm dev:web` 同时启动前端和后端，默认访问 `http://localhost:5173`；后端默认监听 `3030`。需要指定工作区时：

```bash
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

仓库还保留统一 CLI 发行包构建入口。下面的下载地址是占位地址，打包时替换为自己的托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/uwork/
```

产物默认写入 `dist/zcode/`。发行包命令仍为 `zcode`：无参数进入 TUI，`zcode --web` 启动 Web。构建本身不会安装或替换系统中的 CLI。查看参数可运行 `pnpm build:zcode --help`。

## 数据与网络边界

- 为兼容原有数据，内部包名 `@zcode/*`、`ZCODE_*` 环境变量、`zcode` 命令和 `.zcode` 数据目录继续保留。
- macOS 正式版沿用原 Electron userData 路径；更改显示名称不会主动搬迁或清空供应商与会话配置。
- 历史智谱 / Z.ai 模型账号凭据不再用于登录恢复；可选企业身份使用独立凭据与设备会话，远程连接和 MCP 仍保留各自的鉴权。
- 本项目并非完全离线版本。模型请求会发送到配置的供应商，插件、远程工作区、诊断等能力仍有各自的网络行为。不要在公开仓库中提交 API Key、真实配置、日志或会话数据。

运行与执行边界详见 [NOTICE.md](NOTICE.md)。不要把“助理 / 开发”的显示模式当作操作系统沙箱或权限级别。

## 开发检查

```bash
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm architecture:check --changed
pnpm exec tsx --test packages/services/test/providerModelDiscovery.test.ts packages/services/test/customProvidersOnly.test.ts
pnpm exec tsx --test packages/services/test/enterpriseIdentity*.test.ts
```

测试入口与环境依赖以目标包的 `package.json` 和实际测试文件为准。上述 Node 测试使用本地测试数据验证模型发现、UCAS 配置及身份生命周期，不代表真实模型推理或企业微信认证通过。

[企业身份 Electron E2E 脚本](packages/desktop/test/enterpriseIdentity.e2e.mjs)用于未配置认证服务的隔离源码实例，覆盖启动、跳过、再次打开、Esc、模式切换和重载。运行前需单独启动该实例，并通过 `ZCODE_E2E_CDP_URL` 指定本机调试端点。[共享 UI E2E](packages/ui/test/enterpriseIdentity.e2e.mjs)使用测试适配器，并依赖 browser-harness。真实扫码与服务端续期需要另行验证。

## 源码与设计说明

| 目录                                                 | 职责                                     |
| ---------------------------------------------------- | ---------------------------------------- |
| `packages/desktop`                                   | Electron Main、Host、Renderer 和桌面打包 |
| `packages/ui`                                        | 共享 React 界面、hooks 和状态            |
| `packages/services`                                  | 业务服务与持久化                         |
| `packages/provider`、`packages/provider-node`        | 供应商配置、模型注册与 Node 实现         |
| `packages/web`、`packages/server`                    | Web 客户端及 HTTP / WebSocket 服务       |
| `packages/shared`、`packages/rpc`、`packages/client` | 协议、RPC 与 Agent 客户端                |
| `apps/zcode-cli`                                     | Agent、TUI、工具与执行运行时             |

- [自定义供应商与账号入口调整](specs/custom-providers-only.md)
- [模型自动获取与参数编辑](specs/provider-model-discovery.md)
- [UCAS 默认供应商与添加入口规则](specs/ucas-default-provider.md)
- [可选企业身份与跨窗口同步](specs/enterprise-identity.md) · [认证服务对接](docs/enterprise-identity-integration.md)
- [UWork 品牌、模式切换和界面规范](specs/uwork-branding.md)
- [UI 设计规范](DESIGN.md) · [开发约定](AGENTS.md)

复现和排查问题时，请记录系统版本、提交版本、API 格式、脱敏后的路径和操作步骤，不要附带真实密钥。

## GitHub Actions 构建与发布

[桌面发布工作流](https://github.com/Jas0nxlee/UWork/actions/workflows/desktop-release.yml)使用 Node 24.14.0 / pnpm 10.33.2，先执行代码与依赖审计检查，再在原生 runner 上构建 macOS arm64/x64、Windows x64、Linux x64/arm64。

- macOS：DMG、ZIP；Windows：NSIS EXE；Linux：AppImage、DEB、RPM、Arch 包。
- `uwork` 的 push / PR 执行检查。推送与根版本一致的 `vX.Y.Z` 标签会构建并发布；也可在 Actions 的 Run workflow 中选择 `uwork`，开启 `publish` 后发布当前版本。未开启时只保留构建产物。
- 必须全部平台成功，且生产依赖审计没有 high/critical，才会汇总并公开 Release。每个安装包都有 SHA256，完整报告和源码提交随发布提供。
- macOS 当前使用 ad-hoc 签名，未经过 Apple 公证；Windows 当前未配置发布者签名。Linux AppImage 下载后需要添加执行权限。

安装包发布到 [GitHub Releases](https://github.com/Jas0nxlee/UWork/releases)，规则详见 [多平台发布 spec](specs/desktop-github-release.md) 和 [依赖安全修复](specs/release-dependency-hardening.md)。

## 上游与许可

感谢 [ZCode](https://github.com/zai-org/ZCode) 及其贡献者提供基础实现。UWork 的定制功能在本 fork 的 `uwork` 分支维护，不代表上游产品的功能、服务或支持承诺。

第一方代码采用 [Apache License 2.0](LICENSE)。原项目归属和第三方许可继续保留，参见 [NOTICE.md](NOTICE.md)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 [第三方材料说明](third-party/)。
