# UWork 手机 Web 远控：实现规划

本文规划 UWork 如何具备「手机浏览器控制桌面 Agent」的能力（等价于上游 ZCode 的手机远控）。
**结论先行**：客户端 89 个文件、约 2.5 万行的能力不需要自研——上游 v3.15.1 的整套实现已随 PR #5
合并进 `uwork`（2026-10-16，merge commit `a3a46f4d`）。UWork 真正缺的只有四件事：**侧栏入口接线**
（合并时没移植渲染点）、**一个自建的 relay 服务**、**一份手机页静态托管**、**一处把客户端指向自建
入口的配置注入**。

> 状态：规划稿，尚未实现。文中事实核对基于 `origin/uwork` = `c898562c` 与本地合并线
> `e716b651`（2026-10-16）。

## 一、现状事实（均已核对代码/分支）

### 1.1 上游链路

```text
手机浏览器（packages/web 的 /remote/v4 SPA，replayable）
  -> 外部 relay（只做鉴权、配对、心跳、透传，不解析 payload）
  -> Desktop main（webRemoteControlManager：attachment 调度 + RPC 桥接）
  -> 目标窗口共享 Host 的 workspace scope -> 同一 task runtime owner
桌面 renderer（continuous，与手机互不干扰）
```

- 桌面「开启远控」→ 连接 relay（`device` 角色）→ 拿到 `device_sid` → 生成二维码链接：
  `/remote/v4?sid=<device_sid>&hash=<pass_hash>&t=<ts>&mid=<device_mid>&name=<device_name>&app_version=<ver>`。
- 手机打开该链接 → 以 `terminal` 角色连同一 relay → `auth_init`/`auth_challenge`/`auth_response`/`auth_ack`
  → `pair_status: matched` → 之后业务消息全部走 `data.payload`（`rpc-frame` 分片，relay 不解析）。
- 手机没有独立 Host 或 Agent runtime，只能 attach 到桌面窗口已存在的 host；选中态与桌面独立。
- relay 不在本仓：`docs/web-remote-control/web-remote-control-architecture.md` 明确「旧的仓库内 relay
  已移除」，当前 relay（文档里叫 zcode-remote-hub）属于外部基础设施。

### 1.2 代码分布（uwork 现状）

| 位置                                                      | 作用                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `packages/shared/src/web-remote-control.ts`               | 协议类型、错误码、QR URL 构造、**HMAC 测试向量**       |
| `packages/shared/src/web-remote-control-rpc-transport.ts` | 分片/ACK/流控（end-to-end，与 relay 无关）             |
| `packages/desktop/src/main/webRemoteControlManager.ts`    | 桌面侧会话、workspace 匹配、attachment 桥接（1662 行） |
| `packages/desktop/src/main/webRemoteControlTransport.ts`  | 桌面 relay 客户端（注册/鉴权/心跳/重连）               |
| `packages/ui/src/WebRemoteControlDialog.tsx` 等           | 桌面开远控弹层（二维码）                               |
| `packages/ui/src/WebRemoteControlMobileShell.tsx` 等      | 窄屏手机壳、任务首页、任务索引                         |
| `packages/web/src/main.tsx` + `webRemoteControl*.ts`      | 手机页 SPA（Vite，`base=/remote/v4/`）                 |
| `packages/android/`                                       | Android WebView 壳（随合并进入，可选）                 |
| `docs/web-remote-control/*`                               | 12 篇设计文档（架构、稳定性、任务首页、实时同步等）    |

### 1.3 三条会决定方案的硬事实

1. **代码已在 uwork，但界面入口没接线**：`origin/uwork`（`c898562c`）现在含全部远控文件——
   `packages/ui/src` 15 个、`packages/desktop/src/main` 9 个、`packages/shared/src` 3 个协议文件。
   但**没有任何非测试文件渲染 `WorkspaceWebRemoteControlTrigger`**：上游在
   `packages/ui/src/WorkspaceSidebarFooter.tsx:468` 渲染它并透传 `workspaceIdentity`/`remoteSessionId`，
   合并后的 uwork 该文件相对上游是 +14 / −254 行，这段被删掉了。PR #5 正文列的待办第 2 条就是这个
   （「上游 shell 传给侧栏的远控 props 目前『接受不渲染』（切换 UI 未移植）」）。
   → 所以即使从合并后的 uwork 构建，界面上也看不到远控入口。
2. **relay 地址不是从 endpoint origin 派生的**：`resolveWebRemoteControlRelayWsUrl()`
   （`packages/shared/src/zcodeEndpoint.ts:235`）对**任何** endpoint 都返回 `wss://zcode.z.ai/ws`，
   只有 `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 显式覆盖才变。桌面在运行时读该 env
   （`packages/desktop/src/main/index.ts:881`），手机页在构建期读 `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`
   （`packages/web/src/main.tsx:1350`，`env.d.ts` 已声明）。注意 `buildZCodeEndpointUrls()` 其实
   已经算出同源 `wss://<origin>/ws`，只是被上面这层覆盖掉了。
3. **配对是纯 HMAC 口令，不依赖 z.ai 账号**：`pass_hash = base64(sha256(password))`，
   `proof = base64url(HMAC-SHA256(key=pass_hash, msg="<nonce>|<role>|<device_sid>"))`
   （`packages/desktop/src/main/webRemoteControlRelayAuthProvider.ts`）。shared 里带两条
   `WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS`，**自建 relay 可以直接拿它做单测**。
   → 自建 relay 在协议与合规上都是可行的；不需要任何 z.ai 侧服务。

顺带一提：UWork 的企业网关配置（`ucas-gateway.json` + `ucas` provider base URL）**不走**
zcode endpoint origin，所以当前 UWork 打包产物的二维码 URL 默认仍指向 `https://zcode.z.ai/remote/v4`。
这是必须显式改掉的：不改就等于把校内用户的手机流量导到第三方 relay。

### 1.4 这条链路里所有会打到 ZCode 侧的连接（自建清单）

| 连接                          | 谁发起 | 现状                                                            | 自建后                                                                    |
| ----------------------------- | ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| relay WebSocket               | 桌面   | `wss://zcode.z.ai/ws`（device 角色，出站）                      | 自建 relay（P1），配置见 P3                                               |
| relay WebSocket               | 手机   | `wss://zcode.z.ai/ws`（terminal 角色）                          | 同上；手机页在构建期注入（P2）                                            |
| 手机页静态资源                | 手机   | `https://zcode.z.ai/remote/v4`（上游 nginx/k8s 托管）           | 自建 nginx 托管 `packages/web/dist`（P2）                                 |
| help/社区配置                 | 手机   | `communityUrl` 兜底 `https://zcode.z.ai`（点帮助才用）          | 注入 `VITE_ZCODE_BASE_URL=<自建域名>`，或按 UWork 品牌替换社区链接        |
| 远控会话遥测（ARMS/RUM）      | 桌面   | `ZCODE_ARMS_RUM_ENDPOINT`，`remote_usage` 分组上报配对/桥接结果 | **决策点**：置空/关闭，或改指自建观测后端；不处理就是自建后仍有数据出境   |
| legacy `?remoteControlToken=` | 手机   | 会打 `${relayOrigin}/api/remote-control/*`                      | 死路径：当前二维码只带 `sid/hash/t/...`，不进入该分支（可在 P2 顺带清理） |

业务数据面只有 relay 一条：`bootstrap-request`、`workspace-list`、`rpc-frame`（分片）等全部封装在
relay 的 `data.payload` 里透传，手机页与桌面**不直连**任何 z.ai 业务 API；版本校验
（`app_version` 改写）也是走 bridge 由桌面回答，不走网络。

## 二、目标架构（UWork 版）

```text
手机浏览器
  https://<uwork-host>/remote/v4?...      <- nginx 静态托管 packages/web/dist（一张证书、无跨域）
  wss://<uwork-host>/ws                   <- nginx 反代到自建 relay（同域）
        |
        v
  自建 relay（packages/relay，只透传）
        ^
        |  wss（桌面出站）
  桌面 App（配置来自打包内 runtime config，而不是 process.env）
```

交付物：入口接线（P0，改 UI 渲染点）、`packages/relay`（P1，新）、`deploy/web-remote`（P2，静态页 +
nginx 配置 + 镜像）、desktop 侧的 runtime 配置注入（P3，复用企业身份配置那套加载模式）。

## 三、分期实施

### P0 补上入口接线（上游合并已完成）

- 合并已落地：PR #5（`ModestXin:chore/upstream-v3.15.1-sync` → `Jas0nxlee:uwork`）2026-10-16
  合并（`a3a46f4d`），11,807 文件；`origin/uwork` 已含客户端全链路（ui / desktop main / shared /
  web / android）。**不需要再走一遍合并**。
- 缺的是**渲染点**：把上游 `packages/ui/src/WorkspaceSidebarFooter.tsx:468` 那段
  `WorkspaceWebRemoteControlTrigger`（含 `workspacePath`/`workspaceIdentity`/`remoteSessionId`/
  `initialTaskId` 透传）按 UWork 侧栏结构接回来，并核对 `WorkspaceShellLayout` /
  `RootWorkspaceContent` / `app-shell/types` 的 props 链路没有断点。
- 验收：`pnpm typecheck` 全绿；`packages/desktop/test/webRemoteControl*.test.ts`、
  `packages/web/test/webRemoteControl*.test.ts`、`packages/shared/test/webRemoteControl*.test.ts`、
  `packages/client/test/webRemoteControlRelayProtocol.test.ts`、`packages/ui/test/webRemoteControl*.test.ts`
  全过；打包后桌面侧栏可见远控入口、能开弹层出二维码。
- 此阶段结束后功能已经可用，但走的是 z.ai 的 relay 与页面（只适合内部试用）。

### P1 自建 relay（核心工作量）

> **状态（2026-10-17）**：已实现并落地为 `packages/relay`（`@zcode/relay`，private、独立部署、不进桌面 Release）。
> 本节仍描述设计意图；**实现契约、逐条行为与验证记录以 `specs/web-remote-control-relay.md` 为准**
> （其中两条按客户端代码修正的语义：投递不到对端回 `INTERNAL` 而不是静默丢弃；terminal 在无桌面在线时
> 收 `auth_ack{waiting}` + `DEVICE_OFFLINE`）。P2/P3 未做，因此链路默认仍指向 ZCode 侧入口。

新增 `packages/relay`（上游已删除该路径，不会被后续同步覆盖，适合放本仓；协议类型直接从
`@zcode/shared` 导入，避免复制粘贴漂移）。**最小职责只有四件：注册、鉴权配对、心跳应答、透传。**

必须实现的协议（消息形状见 `packages/shared/src/web-remote-control.ts`）：

| 方向           | 消息                                                                                           | relay 行为                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| device → relay | `device_register_init{device_mid, pass_hash, meta}`                                            | 生成 `device_sid` 并落盘（`sid → pass_hash`），回 `device_register_ack`                                                                                  |
| 双端 → relay   | `auth_init{role, device_sid, meta}`                                                            | 记录 socket 角色，回 `auth_challenge{nonce}`（nonce 一次性）                                                                                             |
| 双端 → relay   | `auth_response{device_sid, proof}`                                                             | 用落盘的 pass_hash 校验 proof；失败回 `error{AUTH_FAILED}`                                                                                               |
| relay → 双端   | `auth_ack{device_sid, terminal_sid?, pair_status}`                                             | 双方在线即 `matched`，否则 `waiting`；配对状态变化要立刻推给另一端                                                                                       |
| 双端 → relay   | `pair_status_query{device_sid}`                                                                | 回 `pair_status_ack`（这是 8~12s 心跳；relay 不回，客户端 30s 后自行重连）                                                                               |
| 双端 → relay   | `data{payload}`                                                                                | 原样转发给同 sid 的配对方；**不解析**；超上限丢弃并回 `error{INTERNAL}`                                                                                  |
| relay → 客户端 | `error{code,message}`，`code ∈ AUTH_FAILED / DEVICE_OFFLINE / KICKED / WRONG_PARAM / INTERNAL` | 未知 sid 或桌面不在线 → `DEVICE_OFFLINE`（手机侧有宽限窗口）；同一 sid 第二个 terminal → `KICKED`（手机视为 `session-conflict`）；参数错 → `WRONG_PARAM` |

工程约束：

- 连接参数：桌面会带 `?mid=<device_mid>` 与头 `X-Device-ID`，手机只带 `?mid=`；relay 要把 `mid`
  当**路由提示**（多实例按 `mid` 分片，单实例忽略即可）。桌面会协商 `permessage-deflate`，
  支持它就顺手（大 `rpc-frame` 省带宽），不支持会自动回退。
- 单帧上限对齐 `WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes`（1 MiB），
  超限丢弃而不是断开。
- **落盘很关键**：桌面重启后会用「persisted」模式带旧 `device_sid` 重新鉴权；relay 若无记录，
  会回 `AUTH_FAILED`，桌面重新注册 → 旧二维码全部失效。用一个文件/SQLite 存 `sid → pass_hash`
  就能避免「relay 一重启，所有人都要重新扫码」。
- 不落 payload、不打日志；只记录 `device_sid`、`role`、`code` 这类元数据（上游客户端的安全日志口径一致）。
- 空转回收：桌面在等扫码时会持续发心跳保活，relay 仍应设空闲回收（上游客户端注释里提到过被回收），
  建议 ≥ 90s 并只在无 ACK 流量时触发。
- 交付：`GET /health`（给 compose 健康检查）、单测（协议状态机 + shared 的 HMAC 测试向量 +
  KICKED/DEVICE_OFFLINE/超限）、`tsup` 构建 + Dockerfile。**公网暴露面加固见 §4.2。**

### P2 手机页静态托管

> **状态（2026-10-17）**：已完成。托管在 `https://aihub.ucas.com.cn/remote/v4`
> （网关静态目录 + 构建期注入 `wss://aihub.ucas.com.cn/remote/ws`）。实现细节与网关 location 见
> `specs/web-remote-control-relay.md` 的「P2/P3 也已落地」。

- 构建：`pnpm run build:web-remote-control:v4`（`base=/remote/v4/`），构建时注入两个变量：
  - **必设** `VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://<uwork-host>/ws`——不设的话手机页会回落
    到 `wss://zcode.z.ai/ws`（`resolveWebRemoteControlRelayWsUrl` 对任何 endpoint 都返回它，改
    `VITE_ZCODE_BASE_URL` 不起作用）。
  - **建议设** `VITE_ZCODE_BASE_URL=https://<uwork-host>`：手机页里 `communityUrl`、OAuth 配置等派生
    URL 的兜底是 `https://zcode.z.ai`（`packages/web/src/communityUrl.ts:25`），不设就会去第三方拉配置。
    UWork 的远控手机页不需要这些接口，指到自己的域名即可（拿不到也只是优雅降级）。
- nginx：静态资源 + SPA fallback；`/remote/v4/assets/`、`/remote/v4/material-icons/`、
  `/remote/v4/pdfjs/cmaps/` 必须显式映射到构建产物（上游文档特别指出：让这些请求落进 SPA fallback
  会返回 200 的 index.html，被伪造成「静态资源成功」，Docker smoke 要比对代表性文件内容而不是状态码）。
- 证书与可达性是这一期的主要约束（**公网部署，见 §4.1**）：
  - 手机页必须 HTTPS（否则 `wss://` 不可用），因此必须有**证书链可信的域名**。
  - 现有 `pivot.ucas.com.cn:23090` 的证书是 `*.keepsilent.xyz`，浏览器会拒绝 → 手机页不能放那里。
    需要选一个手机可达且证书有效的入口（`llm.ucas.com.cn` 已有公网入口，或另开 `uwork.*`）。
  - 双域网关是硬约束：**桌面必须能出站到 relay，手机也必须能到 relay。** 桌面在校内网、手机在
    4G 时，relay 必须公网可达（或要求手机连校内 WiFi / VPN）。这是**部署决策点**，不是技术细节。
- 版本成对发布：手机页与桌面对版本（`/remote/v4` 门槛 + 页面会按桌面版本改写 `app_version` 参数）。
  上游用 v3/v4 两条独立静态链路隔离新旧版本，UWork 一期只需一条 `/remote/v4`，但发布时应与
  桌面版本一起回归。

### P3 客户端指向自建入口

> **状态（2026-10-17）**：已完成（方案 A：随包 runtime 配置 `config/mobile-remote-control.json`，
> 优先级 env > 随包配置 > ZCode 默认）。`resolveWebRemoteControlRelayWsUrl` 的同源派生清理**未做**——
> 有显式配置后不再需要，且它会改变所有自定义 endpoint 的既有行为。

当前唯一的注入手段是开发用 env（桌面运行时 `process.env`、web 构建期 `VITE_`），打包后终端用户
拿不到。产品化建议二选一（推荐 A）：

- **A. runtime 配置文件（推荐）**：新增 `config/mobile-remote-control.json`
  （打包后在 `resourcesPath/config/`，dev 在 `.release-config/`，完全复用
  `packages/desktop/src/main/desktopEnterpriseIdentityConfig.ts` 的加载模式），字段
  `{ "remotePageBaseUrl": "https://<host>/remote/v4", "relayWsUrl": "wss://<host>/ws" }`；
  在 `packages/desktop/src/main/index.ts:912` 构造 `getEndpointUrls()`/`relayWsUrl`/`mobileRemoteControlUrl`
  处优先取该配置，env 仍保留为调试覆盖。好处：一次构建多处部署、可按组织覆盖、无需改 Vite/tsup。
- **B. 构建期 define**：在 `packages/desktop/tsup.config.ts` 的 `loadEnvFiles()` 里补两个 `ZCODE_WEB_REMOTE_CONTROL_*`，
  由 CI 注入。改动更小，但每次换域名都要重新打包。

无论哪种，都建议顺手把 `resolveWebRemoteControlRelayWsUrl` 的语义改成「自定义 endpoint origin
同源派生 `${wsOrigin}/ws`」——`buildZCodeEndpointUrls()` 已经算出这个值，只是被覆盖了。这样
UWork 只需要配一处 origin，桌面与手机页自动一致，且不再有「自定义 endpoint 却回落到 z.ai relay」
的隐式行为（该改动要写进 spec，并保留 env 覆盖作为最高优先级）。

### P4 UWork 产品规则与品牌

- 复用 `specs/web-remote-uwork-integration.md` 已定的规则：手机只投影桌面已有 host attachment；
  手机不显示企业身份登录/退出、不触发企业网关自动配置；宽窄屏导航与任务索引行为不变。
- 品牌：手机页 title/favicon、远控弹层与手机壳文案、失败页、`config/default.json` 的
  community/feedback 链接换成 UWork 值。
- 遥测：`reportRemoteUsageEvent` → `desktopRemoteUsageArmsTelemetry.ts` 的 `REMOTE_USAGE_ARMS_GROUP`
  （`remote_usage`）会经 ARMS/RUM 上报配对与 bridge 结果，端点是构建期注入的
  `ZCODE_ARMS_RUM_ENDPOINT`（`packages/shared/src/env.ts:53`）。要自建就得一起决定：关闭该分组、
  置空端点，还是改指自建观测后端（UWork 已裁剪账号与套餐入口，远控遥测要么去掉要么只留本地日志）。
- 权限：手机侧工具能力已受 attachment/capability 约束；企业场景是否需要更严（例如手机禁终端）
  留作决策点。

### P5 验收与发布

1. **relay 契约测试**：直接用 shared 的 HMAC 测试向量 + 两个既有 transport 测试（
   `packages/desktop/test/webRemoteControlTransport.test.ts`、`packages/web/test/webRemoteControlTransport.test.ts`）
   的用例语义，跑一遍真实 relay（把 mock WS 换成集成测试）。
2. **真机 E2E**：桌面开远控 → 手机扫码 → 任务首页 → 打开任务 → 发消息 → 权限弹窗 → 切后台/锁屏恢复
   → 断网恢复 → 桌面重启后启用意图自动恢复 → 手机重连；覆盖 Zai Light/Dark、中英文。
3. **运维自检**：`/health`；relay 重启后旧二维码仍可配对（验证落盘）；`docker ps` 不多容器；
   日志无 payload。
4. **发布**：relay + 静态页纳入 UWork 发布流程（与 `ucas-proxy-prod` 同一台服务器、独立 compose 服务）；
   桌面打包带上 runtime 配置；回滚 = 清空配置（回到默认）或关闭远控入口。
5. 按仓库规矩把「本次验证记录」写回 spec，包含已执行与未执行项（浏览器 E2E 需要手动授权远程调试时
   如实标注未验证）。

### P6 可选（不进一期）

- Android 壳（`packages/android` 已随合并进来）：浏览器扫码已够用；需要常驻/推送时再打包，注意其
  生产包只允许 `https://zcode.z.ai/remote`，换自建域名要改 URL 白名单。
- 局域网直连（不经 relay）：省服务器但要自签证书与手动信任，体验更差，不建议。
- relay 前置企微 OAuth / 内网 ACL：二维码链接本身就是凭证（含 pass_hash，等同密码）。若要求
  「只有本校人员可配对」，在 relay 前加一层鉴权即可，但要先拍板。
- 多组织隔离：远控只投影发起远控的那台桌面，不涉及组织数据，一期无需区分三组织。

## 四、公网部署（已定）与加固清单

**已定：UWork 提供公网服务**，relay 与手机页都放在公网可达的域名上（不是校内网专用）。这改变了
P1/P2 的加固要求——relay 是一个暴露在公网的鉴权入口，必须自己扛住滥用，而不是依赖"内网可信"。

### 4.1 入口与证书

- 一个手机可信的 HTTPS 域名（443），静态页与 `/ws` 同域：nginx 托管 `/remote/v4` 静态资源 +
  `Upgrade` 反代到 relay。同域的好处是一张证书、无跨域、Android 壳的 URL 白名单只需加一条。
- 若前置 CDN/WAF：必须确认支持 WebSocket 长连接（客户端心跳 8~12s、30s ACK watchdog 会一直占着连接）；
  `index.html` 不缓存，`assets/` 可长缓存。
- 证书要能被手机浏览器接受（`pivot.ucas.com.cn:23090` 的 `*.keepsilent.xyz` 证书不可用）。

### 4.2 relay 侧防护（自建就要自己扛）

- **限流**：按 IP/`device_mid` 限制并发 WS 数、注册速率与 `auth_response` 失败次数。proof 是 128 位
  随机口令派生，猜不中，但**连接洪水与房间堆积**是公网必然要防的。
- **房间上限 + 过期回收**：`sid → 房间` 条目设上限与 TTL（配合桌面「刷新二维码」轮换），
  未配对连接空闲回收 ≥ 90s（桌面在等扫码时有心跳保活，不会误杀）。
- **单 sid 单 terminal**（`KICKED` 语义）必须实现，否则会出现两台手机同时控制同一桌面。
- **帧上限 1 MiB**、单连接发送缓冲上限，超限丢弃而不是无限排队。
- **Origin 校验**：terminal 角色校验 `Origin` 属于自建手机页域名（桌面 device 端没有 Origin，
  用 `X-Device-ID`/`mid` 识别）。它是纵深防御，不是主防线——主防线是凭证。
- **日志**：不落 payload；只记 `device_sid` 后缀、`role`、错误码，与客户端安全日志口径一致；
  保留时长按合规要求定。
- **运维动作**：支持按 `device_sid`/`device_mid` 强制断开（应对已知泄露或异常设备）。

### 4.3 凭证生命周期（公网下必须说清）

- 远控链接**本身就是控制权**：QR URL 里的 `sid` + `hash` 谁拿到谁能配对，等于临时密码。
- **停止远控不会作废旧链接**：`stopWindowRuntime()` 不碰 `authStorageProvider`，下次 `start()` 会以
  「persisted」凭据复用同一个 `device_sid`。这是为了支持"桌面重启后自动恢复远控"，不是疏漏。
- **作废入口已经有了**：桌面弹层的「刷新二维码」→ `platform.refreshWebRemoteControlPairing` →
  main 的 `resetPairing()`（停旧连接 + `resetExternalRelayDeviceAuth(reason: "leaked-qr")` + 重新注册
  新 `device_sid`），并且带确认弹窗防误触。
- 因此公网产品的口径是：**链接别外发，泄露就点「刷新二维码」**；二期可考虑给链接加显式有效期
  （桌面侧定期自动轮换）并同步 relay 侧 TTL。

### 4.4 可达性与容量

- 手机在蜂窝网、桌面在任意网络：relay 必须公网双向可达，不能依赖内网。
- 一期单实例（内存态最简，落盘只存 `sid → pass_hash`）。一旦要横向扩容，**必须按
  `mid`/`device_sid` 粘滞路由**（上游边缘层就是按 `query.mid` 分片的，客户端代码注释里记着这个事实）。
- 观测：`/health`、在线房间数、活跃连接、配对成功率、错误码分布；排障先看配对成功率与
  `DEVICE_OFFLINE` 占比。relay 重启会造成一次全量重连（客户端有 jitter 自愈，但要留意重连风暴）。

## 五、需要拍板的决策点

1. ~~手机只在校内网还是出校可用~~ → **已定：公网服务**（本方案按公网加固）。
2. **访问控制**：接受「链接即凭证 + 可刷新」，还是要求配对前过企微登录/白名单？公网下这一条更值得回答。
3. **配置手法**：P3 的 A（runtime 配置）还是 B（构建期注入）？是否要多组织可覆盖？
4. **手机端能力边界**：是否需要禁掉终端等敏感能力（上游默认按 attachment capability 放开）。
5. **链接有效期**：是否需要桌面侧定期自动轮换 + relay 侧 TTL（一期可先"手动刷新"）。
6. **运维归属**：relay 的域名/证书/监控/告警由谁维护，是否纳入现有 `ucas-proxy-prod` 同机部署。
7. **企微身份直连（§7）**：是否作为二期做；"每人一个默认连接"在多台桌面时连最近一台还是给设备列表。
8. **ARMS 远控遥测**：关闭 / 置空端点 / 改指自建后端（见 §1.4）。

## 六、风险与对策

| 风险                                     | 影响                            | 对策                                                                                   |
| ---------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| 上游 relay 协议继续演进                  | 自建 relay 行为漂移、手机连不上 | relay 只做透传不做业务解析；用 shared 类型 + 测试向量做契约测试；把协议版本当作 pin 项 |
| 公网暴露面（连接洪水/房间堆积/爆破）     | relay 被打满、影响所有用户      | 4.2 的限流、房间上限、TTL、Origin 校验、强制断开运维动作                               |
| 远控链接泄露                             | 拿到链接的人可控制桌面          | 已有的「刷新二维码」作废旧链接；公网文案明确"链接=控制权"；二期加自动轮换/TTL          |
| 数据面合规                               | 代码/会话内容经 relay 中转      | 自建 + wss + 不落 payload 日志；relay 由本方运维（不再有第三方）                       |
| 域名/证书不可用（现网证书是 keepsilent） | 手机页直接打不开                | 选域名时先验证手机端证书链，别只在开发机 Chrome 里试                                   |
| 手机页与桌面版本错配                     | 页面白屏或功能缺失              | 静态页与桌面版本成对发布回归；保留 `/remote/v4` 单一链路                               |
| 企业微信/微信内置浏览器行为未知          | 从聊天里点链接打不开            | 一期以系统浏览器扫码为主路径，内置浏览器列为待验证                                     |

## 七、企微身份直连（二期候选，与二维码并存）

目标：手机在**企业微信里点一下**就连上"自己的那台电脑"，不用扫码；同时**保留二维码/链接**入口。
结论：可行，而且身份地基已经现成——ucas-proxy 里已有 `getAuthorizeUrl()`（`scope=snsapi_base`
静默授权，注释明确写了"企微客户端会把裸 5 参 URL 当静默授权链接直接跳回"）、`GET /api/auth/authorize`、
`POST /api/auth/login { code, org_id }` → `signToken({userId, orgId, role})`，且这套正在 pivot 生产上跑。

### 7.1 目标流程

```text
桌面（已登录企微身份）：开启远控 → 注册设备时带上 (orgId, wecom_userid, 显示名)
                        → relay 绑定表 (orgId, userId) → device_sid（新开启覆盖旧的 = 每人一个默认连接）

手机（企微内打开入口）
  → GET /api/auth/authorize（redirect_uri = 手机页回调）→ 静默授权 → code
  → POST /api/auth/login → JWT
  → POST /api/remote/pairing-ticket（新端点）→ 一次性 ticket（30~60s）
  → 手机页连 relay：auth_init{mode:"ticket", ticket}
  → relay 校验 ticket → 查绑定表 → 桌面在线则 matched，否则 DEVICE_OFFLINE（提示"电脑还没开远控"）

二维码入口：auth_init{mode:"password", device_sid, proof}（现有语义，原样保留）
```

### 7.2 要新增的四件事

| 位置                   | 改动                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| 手机页（packages/web） | 免扫码入口分支（读 `?code=`/自动静默授权回调）+ 新的 `ticket` 鉴权分支；沿用现有路由与壳 |
| relay（新建）          | 双鉴权（password / ticket）；`(orgId,userId) → device_sid` 绑定表（落盘、新开覆盖旧）    |
| 桌面 main              | 注册时附带身份（扩展 `device_register_init` 或加一次带身份的注册调用）；弹层显示绑定对象 |
| ucas-proxy             | 新增 `POST /api/remote/pairing-ticket`（鉴权 + 一次性 ticket）；公网可达与 CORS/反代     |

### 7.3 必须写清的三条约束

1. **手机侧不能直连 pivot**：`https://pivot.ucas.com.cn:23090` 只在内网解析，且证书是
   `*.keepsilent.xyz`（手机浏览器会拒）。所以手机的企微授权与换票必须经**公网域名反代**
   （同域 `/api/auth/*` → ucas-proxy），不能靠手机直连内网。
2. **不给免扫码路径下发 `pass_hash`**：ticket 是一次性短票据，手机每次进入都换票；`pass_hash`
   仍只出现在二维码与桌面凭据存储里。
3. **relay 不直连企微**：只校验 ucas-proxy 签发的票据（建议独立 audience/secret，别复用登录 token），
   这样 relay 自身无企微秘密、可替换、可自建。

### 7.4 需要先定的语义

- **"每人默认一个连接"** = 最近一次开启远控的那台桌面（last-write-wins）。同一用户多台机器时，
  先默认连最近那台；要不要给"我的设备"列表（可复用手机任务首页的跨工作区 UI 基础）另定。
- **共用机场景**：一台桌面被多人用。身份模式绑定开启者本人，二维码模式仍是"谁有链接谁能连"；
  relay 的"单 device 单 terminal"语义不因新增模式改变（新 terminal 仍按 `KICKED` 处理）。

### 7.5 工期与风险

- 四处改动（手机页 / relay / desktop / ucas-proxy），比纯 QR 路径多约一倍工作量；建议**二期**做，
  一期先把 QR 路径（P1–P3）跑通，并在 relay 里预留身份扩展点。
- 协议扩展是 fork 专属 → 与上游合并成本上升；契约测试要同时覆盖两种鉴权，绝不动现有
  `password` 语义。
- 最大未知是**企微内置 WebView 的长连接行为**（切后台是否冻结、心跳 8~12s 是否被限流）；
  若冻结严重，退路是"企微里只做入口与授权，连接在系统浏览器打开"。

### 7.6 页面放哪：独立站点 + 企微入口（推荐）

现有"网关应用"的真身是 ucas-proxy 的**员工端 SPA**（Vue + Vant 移动端门户：套餐/模型/密钥/用量，
`frontend/src/views/employee/*`），它本身就被配置成企微自建应用的应用主页
（`routes/auth.ts:170` 的 "Single-org fallback: bare baseDomain (e.g. WeCom app homepage ...)" 就是这场景）。

| 维度     | 远控页独立部署（推荐）                           | 塞进网关员工端 SPA                                 |
| -------- | ------------------------------------------------ | -------------------------------------------------- |
| 上游关系 | 直接跟随上游 `packages/web` 的 `/remote/v4` 构建 | 要 iframe 或在 Vue 里挂 React 应用，升级要手工移植 |
| 形态匹配 | 长连接 + 全屏聊天 + 后台恢复语义                 | 短连接门户（Vant），生命周期与布局都不同           |
| 入口覆盖 | 扫码、链接、外部浏览器、企微内                   | 只有企微内                                         |
| 权限面   | 可独立控制可见范围                               | 与"查 Key/用量"混在一个应用                        |

**结论：页面本体独立部署（一个公网域名下的独立站点），企微侧只做"入口 + 身份"。** 入口有三种粒度，
按需叠加：

1. **工作台入口**：企微应用里加一张卡片/一个菜单（员工端 SPA 加一段即可，或在新建应用主页里放），
   点开导航到远控页（同一 webview）。
2. **应用消息**：任务完成/需要确认时推一条企微消息，点开直达对应任务 —— 这是"做进企微应用"真正的增值，
   也正因为它需要独立的消息模板与可见范围，**建议新建一个自建应用**（如"UWork 远控"，三组织各一），
   而不是复用网关应用：网关应用的可见范围、应用主页（只能一个 URL）与"查 Key/用量"的权限面
   都不适合承载"能操作桌面 Agent"这种高敏感能力。`organizations` 表已有 per-org
   `corpId + agentId(+secret)` 的模型，扩成多应用即可。
3. **二维码/链接**：保留，落在同一个独立站点（系统浏览器）。

三条硬约束：

1. **企微 webview 的长连接行为未验证**（最大风险）。退路是"企微里只做入口与授权，拿到 ticket 后
   用系统浏览器打开远控页"——ticket 一次性 + 短 TTL 正好适配这种"跳出去"的用法。
2. **域名与证书收敛**：企微可信域名/网页授权回调、远控页、relay 建议收在同一个公网域名下
   （一张证书、一次反代配置、一份 CORS 决策），且不能用 pivot 的 `*.keepsilent.xyz` 证书。
3. **企微身份只回答"你是谁"**，不回答"你能不能连那台桌面"；后者仍由 relay 的绑定表（§7.4）决定。

## 八、本次未验证 / 实现时需确认

- relay 服务端的精确行为（`device_sid` 有效期、是否真的会给 device 发 `KICKED`、空闲回收阈值）
  是从客户端反推的，实现时以两个 transport 测试的用例为准逐个校正。
- UWork 打包产物里 `process.env` 注入不可行（已确认代码读法为运行时 env），故推荐 P3-A 的配置文件方案；
  实现时用真实打包产物验证一次。
- 企微/微信内置浏览器的 WebSocket 与 WebView 行为未验证。
- 手机在 4G 访问校内入口的可达性未实测（取决于最终选定的域名与证书）。

## 相关文档

- `docs/web-remote-control/web-remote-control-architecture.md`（上游架构与静态部署链路）
- `docs/web-remote-control/mobile-stability-analysis.md`、`mobile-task-home-design.md`、`task-realtime-sync.md`
- `specs/web-remote-uwork-integration.md`（UWork 侧装配规则，本规划的 P4 直接复用）
- `docs/mobile-remote-control-android.md`（Android 壳，P6 参考）
