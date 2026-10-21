# UWork Source Server 既有文件编辑准入

PR #7 合并审查（2026-10-21）逐文件比较源提交 `3c5b2276` 与本分支。
六个文件均存在于该上游路径，但本地 blob 不同；因此不增加 `acceptedUpstreamSnapshot`，
也不将本地兼容行为冒充原样上游。例外只覆盖 `unmanaged-new-file` 的六条精确路径。

| 既有文件                                                        | 源 blob                                    | 本地 blob                                  | 核对后的本地编辑                                                                            |
| --------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `packages/server/src/source-server/sourceServerProbe.ts`        | `90aab0d5886c6366d336c089d0ef81c56ede4393` | `92f71aecbd3bccd92feb893e03f4997ece1393df` | UWork 安装根/启动器优先，保留 ZCode 旧路径；probe 仍单次读取环境及安装事实                  |
| `packages/server/src/source-server/transportAdapter.ts`         | `8bf8cf162e6432b8b674536dd485007c166f8470` | `9028e1265f462f11f5cde1075f264d3685e54b3a` | 安装、更新、ingress token、stdio 使用同一已解析的新/旧根；既有 backend/transport owner 不变 |
| `packages/shared/src/source-server/release.ts`                  | `4afdf0e971a2d41aabb5214c9bf45f54fdbe4a14` | `3d4993f649a0c4dc3ee888dac7a8d847f4a07b6a` | descriptor 接受新旧归档基名；target、版本、摘要和 URL 验证不变                              |
| `packages/zcode-server-cli/src/packaging/remoteAssetRelease.ts` | `2d766f19fd0000c9f91ff96bd015aeda05e8e05c` | `f83fc3b72c17ec61b2d5ef383e3c1338fe7f9aa8` | 发行归档使用共享 UWork 基名                                                                 |
| `packages/zcode-server-cli/src/runtime/updateHandoff.ts`        | `f450684eb31939b7e64e19917e8c02eba9159790` | `82d5bc657c2b6b4ea4040f22da5067d2d07c68c0` | 两条错误提示中的产品名替换                                                                  |
| `packages/zcode-server-cli/src/server-core/proxyStdio.ts`       | `82d4fd3e17edc4bd2eba34d4d96be2ac1abf789f` | `b85cc36c6631a05999143961d4b7b70b8d04d952` | 两条错误提示中的产品名替换                                                                  |

未新建服务、持久状态或 admission owner，也未开放目录级例外。后续新增 Source Server 路径仍需 managed 模块。
重现：`git diff 3c5b2276 -- <表中路径>`、`git ls-tree 3c5b2276 -- <路径>` 与 `git hash-object <路径>`。
回归入口为现有 sourceServerTransportAdapter、sourceServerContracts、remoteAssetRelease、updateHandoff、proxyStdio 测试。

`packages/ui/src/lib/nextFrame.ts` 在该上游提交不存在，是独立的本地调度器，另行以 managed 模块接管，不属于此例外。
