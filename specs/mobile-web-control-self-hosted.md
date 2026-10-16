# UWork 手机 Web 远控：实现规划

本文规划 UWork 如何具备「手机浏览器控制桌面 Agent」的能力（等价于上游 ZCode 的手机远控）。
**结论先行**：客户端 89 个文件、约 2.5 万行的能力不需要自研——上游 v3.15.1 已经有整套实现，
并已随合并线进入本仓（`chore/upstream-v3.15.1-sync`）。UWork 真正缺的只有三件事：**一个自建的
relay 服务**、**一份手机页静态托管**、**一处把客户端指向自建入口的配置注入**。

> 状态：规划稿，尚未实现。文中事实核对基于合并线 `e716b651`（2026-10-16）。

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

### 1.2 代码分布（合并线上的现状）

| 位置                                                      | 作用                                                   |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `packages/shared/src/web-remote-control.ts`               | 协议类型、错误码、QR URL 构造、**HMAC 测试向量**       |
| `packages/shared/src/web-remote-control-rpc-transport.ts` | 分片/ACK/流控（end-to-end，与 relay 无关）             |
| `packages/desktop/src/main/webRemoteControlManager.ts`    | 桌面侧会话、workspace 匹配、attachment 桥接（1662 行） |
| `packages/desktop/src/main/webRemoteControlTransport.ts`  | 桌面 relay 客户端（注册/鉴权/心跳/重连）               |
| `packages/ui/src/WebRemoteControlDialog.tsx` 等           | 桌面开远控弹层（二维码）                               |
| `packages/ui/src/WebRemoteControlMobileShell.tsx` 等      | 窄屏手机壳、任务首页、任务索引                         |
| `packages/web/src/main.tsx` + `webRemoteControl*.ts`      | 手机页 SPA（Vite，`base=/remote/v4/`）                 |
| `packages/android/`                                       | Android WebView 壳（可选，uwork 基线没有）             |
| `docs/web-remote-control/*`                               | 12 篇设计文档（架构、稳定性、任务首页、实时同步等）    |

### 1.3 三条会决定方案的硬事实

1. **`uwork` 基线分支完全没有这个功能**：`packages/desktop/src/main/` 无 `webRemoteControl*`，
   `packages/shared/src/` 无 `web-remote-control.ts`，`packages/ui/src/` 无 `WebRemoteControl*`，
   `packages/web/src/` 只有 auth 与 share。能力只存在于合并线（`uwork..HEAD` 差 43 个提交，
   其中 `0becde37` 是 UWork 侧的远控装配修复）。
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

三件交付物：`packages/relay`（新）、`deploy/web-remote`（静态页 + nginx 配置 + 镜像）、
desktop 侧的 runtime 配置注入（复用企业身份配置那套加载模式）。

## 三、分期实施

### P0 带入能力（不写新功能）

- 前提：合并线并入 `uwork`。合并线包含上游整树快照（约 1.18 万文件），不要cherry-pick；
  按既有 sync 流程走，并保留 `0becde37` 的 UWork 装配修复。
- 验收：`pnpm typecheck` 全绿；`packages/desktop/test/webRemoteControl*.test.ts`、
  `packages/web/test/webRemoteControl*.test.ts`、`packages/shared/test/webRemoteControl*.test.ts`、
  `packages/client/test/webRemoteControlRelayProtocol.test.ts`、`packages/ui/test/webRemoteControl*.test.ts` 全过。
- 此阶段结束后功能已经可用，但走的是 z.ai 的 relay 与页面（只适合内部试用）。

### P1 自建 relay（核心工作量）

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
  KICKED/DEVICE_OFFLINE/超限）、`tsup` 构建 + Dockerfile。

### P2 手机页静态托管

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
- 证书与可达性是这一期的主要约束：
  - 手机页必须 HTTPS（否则 `wss://` 不可用），因此必须有**证书链可信的域名**。
  - 现有 `pivot.ucas.com.cn:23090` 的证书是 `*.keepsilent.xyz`，浏览器会拒绝 → 手机页不能放那里。
    需要选一个手机可达且证书有效的入口（`llm.ucas.com.cn` 已有公网入口，或另开 `uwork.*`）。
  - 双域网关是硬约束：**桌面必须能出站到 relay，手机也必须能到 relay。** 桌面在校内网、手机在
    4G 时，relay 必须公网可达（或要求手机连校内 WiFi / VPN）。这是**部署决策点**，不是技术细节。
- 版本成对发布：手机页与桌面对版本（`/remote/v4` 门槛 + 页面会按桌面版本改写 `app_version` 参数）。
  上游用 v3/v4 两条独立静态链路隔离新旧版本，UWork 一期只需一条 `/remote/v4`，但发布时应与
  桌面版本一起回归。

### P3 客户端指向自建入口

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
- 遥测：核对 `reportRemoteUsageEvent` / ARMS 相关上报在 UWork 构建下是否需要关闭（UWork 已裁剪
  账号与套餐入口，远控会话遥测要么去掉要么只留本地日志）。
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

- Android 壳（`packages/android` 不在 uwork 基线）：浏览器扫码已够用；需要常驻/推送时再说。
- 局域网直连（不经 relay）：省服务器但要自签证书与手动信任，体验更差，不建议。
- relay 前置企微 OAuth / 内网 ACL：二维码链接本身就是凭证（含 pass_hash，等同密码）。若要求
  「只有本校人员可配对」，在 relay 前加一层鉴权即可，但要先拍板。
- 多组织隔离：远控只投影发起远控的那台桌面，不涉及组织数据，一期无需区分三组织。

## 四、需要拍板的决策点

1. **手机在哪张网上用**：只在校内网（relay 可内网 + 内网证书）还是要出校可用（relay 必须公网 + 公网证书）？
2. **是否加访问控制**：接受「链接即凭证」，还是要求企微登录/内网 ACL？
3. **配置手法**：P3 的 A（runtime 配置）还是 B（构建期注入）？是否要多组织可覆盖？
4. **手机端能力边界**：是否需要禁掉终端等敏感能力（上游默认按 attachment capability 放开）。

## 五、风险与对策

| 风险                                     | 影响                            | 对策                                                                                   |
| ---------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| 上游 relay 协议继续演进                  | 自建 relay 行为漂移、手机连不上 | relay 只做透传不做业务解析；用 shared 类型 + 测试向量做契约测试；把协议版本当作 pin 项 |
| 数据面合规                               | 代码/会话内容经 relay 中转      | 自建 + wss + 不落 payload 日志；如需要可要求 relay 与桌面同网段                        |
| 域名/证书不可用（现网证书是 keepsilent） | 手机页直接打不开                | P2 选域名时先验证手机端证书链，别只在开发机 Chrome 里试                                |
| 手机页与桌面版本错配                     | 页面白屏或功能缺失              | 静态页与桌面版本成对发布回归；保留 `/remote/v4` 单一链路                               |
| 企业微信/微信内置浏览器行为未知          | 从聊天里点链接打不开            | 一期以系统浏览器扫码为主路径，内置浏览器列为待验证                                     |

## 六、本次未验证 / 实现时需确认

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
