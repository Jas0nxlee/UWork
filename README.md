<div align="center">
  <img src="packages/desktop/build/uwork.svg" alt="UWork" width="96" height="96" />
  <h1>UWork</h1>
  <p>使用自己的模型服务，在同一个工作区中处理日常任务与代码开发。</p>
  <p>简体中文 · <a href="README.en.md">English</a></p>
  <p><a href="https://github.com/Jas0nxlee/UWork/tree/uwork">源码</a> · <a href="LICENSE">Apache-2.0</a></p>
</div>

UWork 是基于 [zai-org/ZCode](https://github.com/zai-org/ZCode) 定制的 AI 工作台。当前版本以自定义模型供应商为中心，移除了桌面应用账号登录和智谱内置套餐入口，并调整了品牌、模式切换与模型设置流程。

本仓库由 fork 维护者独立维护，并非上游官方发行版。**默认分支为 `uwork`**，`main` 保留上游代码，便于后续比较和同步。

## 当前功能

| 功能           | 说明                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 自定义模型服务 | 配置 Base URL、API Key 和 API 格式，支持 Chat Completions、Responses、Anthropic Messages。                                |
| 自动获取模型   | 从供应商读取模型 ID，去重后批量添加；已有模型的参数、启停状态和顺序保持不变。                                             |
| 模型参数编辑   | 编辑上下文窗口、输出上限、输入类型及推理选项；已修复导入模型后保存参数时漏传版本号的问题。                                |
| 助理 / 开发    | UWork Logo 右侧显示当前模式，点击同一个按钮切换，选择会被记住。助理侧重过程摘要与结果，开发展示更多代码、命令和修改细节。 |
| 工作区与任务   | 保留项目、会话、文件、终端、Git，以及插件、MCP、技能和子智能体等上游能力。                                                |
| 定制界面       | UWork SVG 字标与 U 图标、UCAS 渐隐背景、深浅主题；右上角帮助菜单仅保留资源管理器。                                        |

模式切换只改变界面呈现，不改变工具权限或模型服务权限。官方自动更新已停用，更新本定制版需要重新构建安装。

## 配置模型并开始使用

1. 打开 **设置 → 模型设置 → 添加供应商**，选择模板或创建自定义供应商。
2. 填写服务商提供的 **完整 API Base URL**，选择对应 API 格式并填写 API Key。
3. 点击 **自动获取**，或通过 **添加模型** 手动输入模型 ID。
4. 按服务商实际能力调整模型参数，再在聊天窗口选择供应商和模型。

以下为虚构地址示例，使用时替换成自己的服务地址：

| API 格式           | Base URL 示例                | 对话请求路径           |
| ------------------ | ---------------------------- | ---------------------- |
| Chat Completions   | `https://api.example.com/v1` | `/v1/chat/completions` |
| Responses          | `https://api.example.com/v1` | `/v1/responses`        |
| Anthropic Messages | `https://api.example.com/v1` | `/v1/messages`         |

模型列表可访问，不代表每个模型都能执行推理或支持工具调用。请以服务商文档、权限与一次实际对话结果为准。

### 已知问题：自动获取成功，对话却返回空内容

当前自动获取会为根地址尝试 `/v1/models`，但**不会把探测出的 API 前缀写回 Base URL**。如果服务商实际要求 `/v1`，而配置里只填写了域名，Chat Completions 对话可能请求到网站页面，最终显示“模型未返回任何内容”。

请将 Base URL 改为服务商要求的完整 API 前缀，例如 `https://api.example.com/v1`。自动发现与对话路径的一致性修复尚未包含在当前版本中。

## 从源码运行

当前定制版已在 **macOS Apple Silicon** 上完成构建和界面验证。仓库仍包含 Windows、Linux、Web 与 CLI 入口；这些平台不等于已经完成相同范围的发布验收。

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**。工具版本以 [mise.toml](mise.toml) 为准；macOS 编译原生组件还需要 Xcode Command Line Tools。以下命令从仓库根目录执行。

```bash
git clone --branch uwork https://github.com/Jas0nxlee/UWork.git
cd UWork
pnpm bootstrap
pnpm dev:desktop
```

`bootstrap` 安装依赖、准备本机运行资源并构建相关包，默认跳过远程资源。Agent 源码已包含在 `apps/zcode-cli/` 中。

开发时建议使用独立数据目录，避免混入日常使用数据。以下环境变量写法适用于 macOS / Linux：

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
ZCODE_ENV=production ZCODE_SKIP_REMOTE_ASSETS=1 \
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
- 历史应用账号凭据不再用于登录恢复；移除应用登录不等于取消远程连接或 MCP 的鉴权。
- 本项目并非完全离线版本。模型请求会发送到配置的供应商，插件、远程工作区、诊断等能力仍有各自的网络行为。不要在公开仓库中提交 API Key、真实配置、日志或会话数据。

运行与执行边界详见 [NOTICE.md](NOTICE.md)。不要把“助理 / 开发”的显示模式当作操作系统沙箱或权限级别。

## 开发检查

```bash
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm exec tsx --test packages/services/test/*.test.ts
pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/*.test.ts
```

[Electron E2E 脚本](packages/desktop/test/uwork.e2e.mjs)覆盖模式切换、模型获取、去重、错误处理及导入后的参数编辑。运行它需要单独启动使用隔离数据目录的源码构建，并通过 `ZCODE_E2E_CDP_URL` 指定本机调试端点；测试会创建供应商，不能连接日常使用的配置目录。

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
- [UWork 品牌、模式切换和界面规范](specs/uwork-branding.md)
- [UI 设计规范](DESIGN.md) · [开发约定](AGENTS.md)

复现和排查问题时，请记录系统版本、提交版本、API 格式、脱敏后的路径和操作步骤，不要附带真实密钥。

## 上游与许可

感谢 [ZCode](https://github.com/zai-org/ZCode) 及其贡献者提供基础实现。UWork 的定制功能在本 fork 的 `uwork` 分支维护，不代表上游产品的功能、服务或支持承诺。

第一方代码采用 [Apache License 2.0](LICENSE)。原项目归属和第三方许可继续保留，参见 [NOTICE.md](NOTICE.md)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 [第三方材料说明](third-party/)。
