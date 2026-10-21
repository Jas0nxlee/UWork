# ARMS 共享模块生成产物同步

## 合同与边界

`packages/desktop/src/shared/armsRumShared.ts` 是 collectors、页面名解析及 Browser SDK 初始化配置的源码所有者。
既有构建期可选能力合同见 [桌面构建期可选能力](../docs/desktop/build-time-optional-capabilities.md)：
`ZCODE_ARMS_RUM_ENDPOINT` 为空时 `enable` 为 false，显式配置测试 endpoint 时为 true；生成输出必须保持该行为。
本次不修改 TS 源码、配置来源或开关规则。

已跟踪的 `.js`、`.d.ts`、`.js.map`、`.d.ts.map` 作为同一次单模块发射结果同步；
只发射该 sourceFile，不运行会批量写入依赖项目的全局编译。输出格式化后，两个 map 的 generated 行列必须同步对应最终文本，
source 仍指向同目录 `armsRumShared.ts`。

```text
构建期配置 → @zcode/shared 常量 → 唯一 TS 模块
                                  └→ JS / 声明 / 两个 map 同步
                                      └→ Main 与 renderer 按现有 .js 导入读取
```

## 已确认原因与验收

- 源码已使用 endpoint 判定，旧 JS 仍写死 enable=true。现有 `.js` / `.d.ts` 本地改动仅是格式变化，未修正这项陈旧行为。
- 实际 esbuild（Main 与共享初始化入口）及 Desktop Vite client resolver 都选择同目录真实 JS；普通 Vitest 导入无法作为产物正确的充分证据。
- 专属回归读取磁盘 JS 原始字节，复制到没有 TS 候选的临时 Node ESM 包，以最小 shared 依赖夹具运行；不初始化真实 SDK、不发送网络请求。
- 验证空 endpoint 关闭、测试 endpoint 开启，env/version 继续透传，8 个 collectors 与独立配置副本保持原语义。
- 覆盖 file URL、HTTP path、查询串排除、根路径、无效 URL 和长路径截断；JS 与 TS 的独立字符串编译结果相同。
  规范化使用根包已声明的 TypeScript，两个输入采用相同文件名与编译选项，移除注释和 sourceMappingURL；不得依赖 hoist 暴露的未声明工具或按路径解析替换磁盘 JS。
- 两个 map 的模块导出标识及 JS endpoint 判定位置均能定位回当前 TS；map 文件名、source 与最终生成文本一致。

回归直接扩展现有 CI 准入入口 `scripts/test/arms-patch-install-contract.test.mjs`，保留原 ARMS 安装补丁校验。

上述证据确认配置生成与解析路径正确，不将其扩展为真实 ARMS 后台投递或已安装客户端验收。
