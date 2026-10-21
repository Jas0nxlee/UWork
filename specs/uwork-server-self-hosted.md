# 自部署 UWork Server（远端工作区）

3.16.2 起，桌面通过 **SSH / WSL / Docker** 连接远端机器时，会在那台机器上安装并运行一个常驻的 `uwork-server` daemon，工作区就是远端目录（R3「Source Server」主链）。本文记录这套资产的**构建、发布布局、客户端指向与命名口径**；产品行为见 `docs/architecture/r3-source-server-remote-architecture.md`。

## 一、资产与构建

远端 server 的归档**不随安装包分发**，按版本从 CDN 取。每个版本构建一次（6 个 target，`--linux` 只出 Linux）：

```bash
pnpm --filter @zcode/server-cli stage:remote-assets          # darwin/linux/win × x64/arm64
pnpm --filter @zcode/server-cli stage:remote-assets --linux  # 仅 Linux（开发/内网常用）
```

产物（`packages/zcode-server-cli/dist-release/`，同时落到 `packages/desktop/mock-cdn/releases/<版本>/`）：

- `uwork-server-<target>.tar.gz`（约 87–88 MB，**自带 Node 22.16.0 运行时**，含 `bin/uwork`、`runtime/server-cli.js`、`server-core.js`、`node_modules` 与三方声明）
- `source-server-release.json`：按 target 列出 `fileName` / `sha256` / `sizeBytes` / `urls`

## 二、发布布局（我们自己的静态源）

```
<base>/<版本>/source-server-release.json
<base>/<版本>/uwork-server-linux-arm64.tar.gz
<base>/<版本>/uwork-server-linux-x64.tar.gz
<base>/<版本>/uwork-server-darwin-arm64.tar.gz   # 需要 macOS 远端时
... （6 个 target）
```

`<base>` 由构建期环境注入：`CDN_DOMAIN` + `OSS_PATH_PREFIX`（`packages/desktop/tsup.config.ts` → `__ZCODE_REMOTE_CDN_RELEASE_ROOTS__`，默认前缀 `zcode/electron/releases`）。运行时/本机也可用 `remoteCdnBaseUrls` 覆盖（测试或私有部署）。

## 三、远端前置

- `curl` 或 `wget`、`tar`、`sha256sum`/`shasum`/`openssl`（连接前 `remoteAssetPreflight` 会探测）
- 安装根：**`~/.uwork/server`**（`bin/uwork`）；旧安装 `~/.zcode/server` **继续接管、不迁移**（新根不存在且旧根存在时沿用旧根）
- 内网离线可用：归档与 daemon 都不依赖厂商端点；只有取归档时需要能访问我们自己的静态源（也可"本地下载后上传"，此时只要求本机能到源）

## 四、命名与兼容口径

| 面                 | 现在                                                                                                            | 兼容                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| manifest `product` | `uwork-server`                                                                                                  | 读入接受 `zcode-server`（3.16.2 之前的发行包），归一化为新值                              |
| 归档名             | `uwork-server-<target>.tar.gz`                                                                                  | 解包接受 `uwork-server-`/`zcode-server-` 两种根前缀；descriptor `fileName` 两种基名都可读 |
| 启动器             | `bin/uwork`                                                                                                     | probe/transport/launch 优先 `bin/uwork`，回退 `bin/zcode`                                 |
| 安装归属 marker    | `uwork-server`                                                                                                  | 旧 marker 视为兼容，不判成"别人的安装"                                                    |
| 用户文案           | "UWork Server"                                                                                                  | —                                                                                         |
| 保留不动           | 包名 `@zcode/server-cli`、`ZCODE_*` env、`zcode-server.cjs`（旧直连链）、`node_modules/.cache/zcode-server-cli` | 契约/历史命名不随品牌改                                                                   |

## 五、实测记录（2026-10-21）

本机 Docker（`ubuntu:24.04` + sshd，`dev@127.0.0.1:2222`，aarch64）+ 本地静态源（`python3 -m http.server`）：

1. `sourceServerReleaseResolver` 从自有源取 descriptor（200）→ 下载 `uwork-server-linux-arm64.tar.gz`（200）→ **sha256 校验通过**
2. SFTP 上传 → 解包 → `bin/uwork --version` = `3.16.6`；`--version --json` = `{"product":"uwork-server","version":"3.16.6"}`；`manifest.json` 的 `product` = `uwork-server`
3. `bin/uwork serve --daemon` → `status --json` = `{"state":"ready","port":…}`，日志 `UWork Server ready at 127.0.0.1:…`；`stop` → `state:stopped`

## 六、升级模型：daemon 只随客户端升级，不自己升级

**远端 Server 不允许自我升级**，运行时也不从 CDN 拉版本或组件。升级一律由桌面端驱动：

1. 客户端按版本从我们的静态源取 descriptor + 完整归档（校验 sha256）；
2. 上传到远端（`~/.uwork/server/.bootstrap-<op>/uwork-server.tar.gz`）；
3. 在远端执行归档自带的 `bin/uwork update --from-archive <归档> [--force]` —— 这就是 `packages/server/src/source-server/transportAdapter.ts` 安装与更新用的同一条命令。

因此：

- 运维在远端直接跑 `uwork update`（不带 `--from-archive`）会被**明确拒绝**并提示"由桌面端驱动"；在线自升级链路（`updatePreparation.ts`、`releaseDownload.ts`、`ComponentCache` 等）已从本仓库删除，运行时不再有任何拉版本的网络代码。
- **自部署只需要发布"完整归档 + descriptor"**，不必产出组件级 `manifest-<target>.json` 与组件包。
- 护栏保留：`update --from-archive` 仍会通过 `prepare-update` 控制命令检查运行中的任务（需要时用 `--force`）；`apply-update` 只能应用**磁盘上已存在**的 pending release，且**启动时不会自动应用**。

## 七、不覆盖

旧直连链（`packages/server/src/remote/**`，组件目录 / `manifest-<target>.json` 形态，部署 `zcode-server.cjs` 到 `~/.zcode/server`）保持原样；设置页「远程设备管理」里的 SSH/WSL/Docker 走的是本文描述的完整归档链路。若将来要启用旧直连入口，需要另行产出组件级清单。
