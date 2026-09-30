# 发布依赖安全修复

- 本次正式发布必须消除 `pnpm audit --prod --audit-level=high` 中的 high/critical 报告。按公告修复版本更新依赖，优先保留主版本；Electron 保留 41 系列并更新到 41.10.7。
- electron-builder 的 `electronVersion` 必须直接使用桌面 package.json 中的固定版本；通过加载真实打包配置的测试校验两者一致，禁止打包配置中的旧硬编码绕过已更新的锁文件。
- transitive resolution 由根 `pnpm-workspace.yaml` 的 overrides 唯一控制，提交根锁文件；不以忽略公告、修改审计返回值或临时目录中的修改绕过检查。
- 原有 React 固定版本和三份 dependency patch 同步迁到 workspace 配置，删除 package.json 中重复设置，避免 pinned pnpm 与外层新版 shim 对配置优先级的解释不同。
- `extract-zip@2.0.1` 没有上游修复版本。使用 workspace 包 `@uwork/safe-extract-zip` 作为已有 `extract-zip` 消费者的兼容适配器，公开接口仍为 `extract(zipPath, {dir, onEntry?, defaultDirMode?, defaultFileMode?}): Promise<void>`。这是工具链 ZIP 解包边界，不拥有身份、workspace 或应用状态。
- Playwright 的浏览器下载进程还内嵌旧解压实现，普通 override 不能替换它。对锁定的 `playwright-core@1.59.1` 添加可复现 patch，将该消费者切换到同一个公开解压入口；通过 packageExtensions 声明依赖，不在安装后的 node_modules 中保留手工改动。
- `yauzl` 负责有界、逐条读取和 ZIP entry size 校验；适配器唯一拥有当前解压流程。目录必须为绝对路径；ZIP entry 拒绝绝对路径、反斜杠、驱动器、空/点/父路径分量及 NUL。写文件前逐级验证父目录，不沿符号链接写入，不覆盖链接或特殊文件。
- 允许 Electron.framework 所需的相对内部链接；链接目标不得在逻辑或实际解析后离开 root。链接内容长度有界，全部链接在完成前再次校验。失败立即关闭归档并拒绝 Promise，不继续处理 entry。
- 调用方必须独占目标目录并提供受信回调。威胁模型包括不可信 ZIP 和原有文件/链接，不把拥有同等本机写权限、并发修改目录的进程当作该适配器能够隔离的对象。CI 的每个 build 使用独立 runner 和 checkout。
- 验收覆盖正常文件和执行权限、内部 Framework 链接、entry 路径穿越、绝对/外部链接、预存链接和通过链接覆盖外部文件；测试必须核对 root 外文件保持原值。另用真实 Electron 归档验证兼容性。
- 发布检查还包括 typecheck、lint、架构、登录/供应商及原生布局回归和五个平台的实际构建。审计通过仅表示当前数据库不再报告 high/critical，不表示不存在其他未知风险。
