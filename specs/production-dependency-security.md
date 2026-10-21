# 2026-10-21 生产依赖高危门禁修复

范围为 `pnpm audit --prod --audit-level=high` 当前报告的 15 个 high、0 critical；保留门禁和全部既有补丁，不批量更新 low/moderate。

## 来源与版本边界

对比 `origin/uwork`（9c6d96bb）、纯净 PR7（3eecbe78）及本次修复前 HEAD：下列旧版本均已在三份锁文件存在。
PR7 新增 `packages/ui → exceljs` 生产依赖，使 tmp 与 brace-expansion 两个主版本的 11 条报告进入该生产链；
follow-redirects 与 MCP server 的 4 条报告对应 uwork 已有生产入口，不能把公告出现时间误认为 PR7 引入时间。

| 生产边界                      | 报告数量 | 原版本 → 精确修复版本                                                             | 官方依据                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | -------: | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ExcelJS 流式临时文件          |        1 | tmp 0.2.5 → 0.2.7，限同一 0.2 主版本族                                            | [路径穿越](https://github.com/advisories/GHSA-ph9p-34f9-6g65)                                                                                                                                                                                                                                                                 |
| ExcelJS/archiver 的 glob 参数 |       10 | brace-expansion 1.1.14 → 1.1.20；2.1.0 → 2.1.6，分别保留主版本；已有 5.x 策略不变 | [递归深度](https://github.com/advisories/GHSA-qhr7-859c-m2p7)、[逗号分组递归](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p)、[中间展开](https://github.com/advisories/GHSA-rgw5-rvv9-x895)、[输出长度](https://github.com/advisories/GHSA-mh99-v99m-4gvg)、[空组展开](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) |
| 服务端 HTTP 重定向凭据        |        2 | follow-redirects 1.16.0 → 1.16.1                                                  | [数组头](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8)、[敏感头名转义](https://github.com/advisories/GHSA-8r9p-f939-6h3c)                                                                                                                                                                                                |
| MCP v2 插件协议               |        2 | server 2.0.0 → 2.3.0，core/client 同步精确 2.3.0                                  | [共享 HTTP 实例](https://github.com/advisories/GHSA-jm63-cq47-j5jp)、[输入验证内存消耗](https://github.com/advisories/GHSA-46jr-4wx8-v453)                                                                                                                                                                                    |

MCP server 2.3.0 的 registry 声明精确依赖 core 2.3.0；不将 server 单独升级后保留不配套的核心类型。
当前 v2 server 生产导入仅在 Android/iOS/Node REPL 插件，均为 stdio；两份公告明确 stdio 不受对应 HTTP 漏洞影响。
HTTP 输入元素限制在新 SDK 中默认关闭，不能把升级本身宣称为给任意 HTTP 服务增加了限流。
本轮不引入共享 HTTP server、认证流程或新的业务 owner。

## 不变量与验收

- 临时文件 API 拒绝 prefix/postfix 中的父目录跳转及数组/对象类型绕过，正常文件仍创建在指定临时根，测试只使用受控临时目录并清理。
- 两个 brace-expansion 主版本均保持普通模式展开；深层输入不能造成栈溢出，输出数量上限可执行。
- 真实两个本机 HTTP origin 重定向时，数组形式 Authorization/Cookie/Proxy-Authorization 及带合法正则元字符的敏感头名均不泄露；普通头仍传递。
- 沿用真实 ExcelJS 内存/流式/乱序 ZIP 回归，保留 exceljs/unzipper 两个已有归档补丁。
- MCP v2 真实 stdio 初始化、工具调用、生命周期和版本协商回归，services/plugin-ui-bridge 客户端交互，HTTP binding/auth 组及完整 CLI build 均验证。
- 使用当前冻结生产图审计，要求 high/critical 均为 0；low/moderate 单独如实记录。
- 安装策略 allowBuilds 不扩大；锁文件由 pnpm 生成；最终 NOTICES/inventory 从实际安装图重新生成并核验输入哈希。

唯一同时覆盖的 dev 同族边是现有 `tmp-promise → tmp@0.2`：定向刷新 ExcelJS 时 pnpm 会把该边重解到存在类型绕过的 0.2.6。
因此使用一条 `tmp@^0.2 → 0.2.7` 精确策略统一两条同主版本边，去掉 ExcelJS 专用 tmp 策略；
不改变 tmp-promise 本身版本或其异步接口。该 wrapper 的正常创建/清理另用真实调用验证。
