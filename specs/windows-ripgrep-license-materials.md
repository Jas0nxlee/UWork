# Windows ripgrep 可核验构建材料采集

此模块只采集材料，不构建、发布、改写 native 配置或关闭现有许可阻断。生产方唯一拥有
源码/补丁、工具链安装、`-Zbuild-std=std,panic_unwind`、编译 flags、PE/BinSkim、二进制和归档
哈希；采集器将同一次实际构建绑定到原始许可和完整依赖图。

固定公共工具链为 nightly-2025-06-26、release1.90.0-nightly、commit
0fa4ec6cde46fa17ab07acb5531cfe0dc1349ffa，官方日期 manifest SHA-256
4ab56f5eae0b8d5a58ce20c5197117be9facc4edceca01f8122f7aaf5baf9645。
源码为 ripgrep14.1.1 /4649aa9700619f94cf9c66876e9549d83420e16c，保留 producer 的微软安全补丁。
禁止用公开材料冒充旧私有 6a6eaca… 二进制；旧阻断必须等实际归档替换后另行退役。

接口：`node scripts/collect-windows-ripgrep-license-materials.mjs --source-dir ... --cargo-home ...
--rustup-home ... --toolchain nightly-2025-06-26 --target {x86_64,aarch64}-pc-windows-msvc
--output-dir ... --build-manifest ...`。构建 manifest 同目录应包含 `Cargo.lock`、
`cargo-metadata.json`、`rustc-vv.txt`、`rust-channel-manifest.toml`、`std-Cargo.lock`、
`std-cargo-metadata.json`、`cargo-build-messages.jsonl`；可用同名 CLI 参数显式指定文件。

- 只接受固定两目标与上述工具链，核验 rustc release/commit/host、官方 manifest 原字节摘要、
  源码/补丁/锁摘要和 producer manifest 目标。源码锁与保存副本必须逐字节一致。
- 分别遍历两份 metadata 中 ripgrep/std 的 target-filtered resolve graph，包含 normal/build
  依赖并排除 dev 边。所有实际 compiler-artifact package_id 必须被两图覆盖；必须观察到
  core/alloc/std/panic_unwind/compiler_builtins 重编产物，不能把预编译 std 当成重编完成。
- Cargo registry 材料直接从锁文件 checksum 核验的原 `.crate` gzip/tar 取得，不能相信可修改
  的解压源树自报 checksum；保留 root/嵌套 LICENSE、COPYING、COPYRIGHT、NOTICE、AUTHORS
  与显式 license_file。缺完整文件时失败，不按 SPDX 拼版权。工作区原文只从所声明源码根读取。
- Rust sysroot 的原始 COPYRIGHT.html、COPYRIGHT-library.html、实际存在的引用文件以及同 compiler
  commit 的完整 LICENSES/COPYRIGHT/MIT/Apache 原始快照一并
  保留，拒绝未渲染模板或丢失相对链接。Rust-src in-tree 包绑定同 commit 的官方原文；
  额外 registry std 依赖仍独立核验。保守集合标明含 build-only，不能声称所有包实际链接。
- nativeRuntime 提供的 MSVC/CRT/Spectre 原文也按 publisher 来源及摘要原样保存；缺失时在
  输出明确未证明范围，CLI 返回非零并阻止晋级；不能宣称工具链所有嵌入组件已审核。最终分发审核由实际归档 owner 负责。
- 输出 materials.json 与原文字节只在全部必需校验成功后有完成标志；不修改仓库登记、
  不外发请求，不包含凭据/环境变量。验证缺失锁/缓存、错版本/目标/摘要、缺 artifact、
  来源越界或删许可证时必须失败，正常 fixture 的字节/依赖图保持可复验。

当前实际 release profile 的 panic 语义为 unwind，不能注入 abort 改变原工具行为。采集器按
producer manifest 的已知 panicStrategy 绑定相应 std artifact，未知策略拒绝。

官方布局依据为固定 Rust commit 和已实际核验的 dated rustc 归档：包含两份版权 HTML 与
12 份 `licenses/*.txt` 原件。GenerateCopyright 自身返回两份 HTML，不能据此推断归档只有两个文件。
同 commit 的15份原始 source notice 快照与目录登记摘要固定在采集器，不能改 SPDX 拼条款。

## MSVC 发行材料的精确绑定

只按真实 Windows 构建的 IDE、VC toolset、SDK 与三份 release Spectre 库 SHA 选择受审 binding。
不能把 NuGet/.NET 的安装器 EULA 当成 CRT 授权，也不能把 2026 材料冒充 2022。每个 binding
登记适用的官方开发工具 EULA、发行清单、静态 CRT 的官方部署依据；对应发布方原件和完整
文字提取快照同时核验摘要并保存，策略本身也作为采集输入原样保存。匹配不到精确版本或库
摘要时继续 incomplete；公开文档存在不自动关闭其他架构的范围。
输出 `nativeRuntimePolicySnapshot` 保存策略原字节记录，`nativeRuntimePublisherOriginals`
保存发布方原件记录；最终 seal 会逐一重算这两个字段里的文件摘要。

首个 x64 证据为 run38530696328、VS17.14.37710.0、VC14.44.35207、SDK10.0.26100.0。
静态 release CRT 的技术范围来自 Microsoft CRT library features 与 Deployment Concepts；
发行要求保留适用 EULA 的 Section5 和对应 REDIST，不能将工程材料检查描述为独立法律认证。
