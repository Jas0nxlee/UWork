# 上游 v3.15.1 同步修复状态（2026-10-14，WIP）

本 PR 将上游 `aac4755` 的 v3.15.1 快照同步到 UWork。机械合并和类型检查不等于产品验收；本轮修复审查发现的发布、迁移和远控接缝，仍保留未收敛的全量测试与严格许可材料缺口。

## 已修复

- 依赖策略收口到 `pnpm-workspace.yaml`，重生成根锁文件及 packageExtensions 校验和，移除快照中的旧 npm 锁。保留安全解压与六份有效补丁；Electron 开发、锁文件和发布均使用 41.10.7。生产依赖审计 high=0、critical=0。
- 恢复打包配置中的企业身份公开配置路径、存在性和发布必需校验；Windows 安装清单独立于 Computer Use producer，placeholder 包仍生成升级所有权清单。
- 数据目录迁移重新委托唯一 UWork 全根迁移实现，保留冲突拒绝、原子激活与元数据路径重定位，禁止误复制另一应用的 `.zcode/v2`。
- 套餐兼容服务恢复既有 provider 无关的退役边界，并实现上游新接口。动态工作流使用本地 offer 和当前用户选择，UCAS 初始化不等待上游 client/configs。
- 手机三种 Root 显式使用企业身份只读投影，修复 Root 到 shell/sidebar 的 switcher、导航和 transport 状态透传，恢复桌面任务索引与重连接线。桌面 continuous、手机 replayable 的运行时所有者不变；手机不重复启动职业或迁移引导。
- 补齐缺失中文词条并保留现有 UWork 定制，Web 图标复用既有 UWork 资产。GB2312 编码夹具改用数据扩展名，保留字节和实际读写测试，没有扩大 lint 排除范围。
- 补齐 safe-extract-zip 与 Gen UI 公共契约验收。许可生成器读取 workspace 唯一补丁策略；核验 rrweb 2.0.0 精确源码许可并重生成通知及 inventory。

## 已执行验证

- Node 24.14.0 / pnpm 10.33.2：frozen 安装、typecheck、lint、全仓架构检查均通过。Lint 仍有已有 warnings，不能称无告警。
- 桌面 Agent CLI 与完整 Desktop 主进程、preload、renderer 构建通过；未生成五平台安装包。
- 发布配置、安全解压、真实 ASN.1 ASAR 闭包、补丁与许可生成回归进入 CI；企业身份、网关、AIHub、UWork 路径等 Node CI 验收 129/129 通过。
- 服务修复回归 Node 10/10、Vitest 95/95；UCAS 装配与夹具回归 32/32，Server 2/2；桌面环境与发布策略回归 89/89，编码适配器 34/34。
- browser-harness 离线场景覆盖真实 Web main → Root 首页的 390px / 1200px、明暗主题，以及同路径不同 workspace identity 切换、进入聊天、恢复提示和身份只读计数。夹具不连接真实企业微信、外部 relay、SSH 或 Agent 生成，不能当作真实配对验收。

## 尚未关闭

1. 统一收尾的全量 Vitest 报告为 18,138 项：17,693 通过、435 失败、10 跳过；全量尚未通过。原生 Node 安全验收使用独立 runner（44 项发布与 129 项企业集成通过），不把框架误收导致的「No test suite」当作功能失败。第一轮的 547 项失败报告保留为排查依据，未按减法推定最终结果。
2. 上游测试仍有旧品牌、旧数据根、已裁 OAuth/账号套餐及旧 Footer 假设。需要逐项按 UWork 产品契约修正；不能为了全绿恢复已退役产品功能，或直接删除/跳过失败测试。
3. 基础许可与声明新鲜度检查通过；严格许可检查仍保留 18 项待核验材料，详见 `third-party/inventory.json` 的 `reviewRequired`。不能据此声称严格合规或可正式发布。
4. 尚未完成真实手机与桌面配对、三组织扫码/回调以及五平台安装包验收；本轮提交不发布版本，也不执行合并。

企业身份只读开关约束手机初始化和切换时的自动身份恢复、登录、退出及自动网关同步；本轮没有将现有设置面板的全部显式 RPC 写权限重新设计为服务端授权规则。
