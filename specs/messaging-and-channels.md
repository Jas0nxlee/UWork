# UWork 基础 IM：单聊 / 群组 / 频道实现规划

本文规划在 UWork 里实现**基础 IM**：单聊（点对点）、群组、频道，以及未读与历史漫游。
第一版的主体是**人 ↔ 人**；agent 作为「频道成员」是后续叠加的差异化能力（见 §4 P2），不阻塞第一版。

**结论先行**：

1. **服务端新建独立服务 `msgbus`，不放进 ucas-proxy、也不复用 relay。**
   ucas-proxy 是 Express + `better-sqlite3` 同步单进程、全仓无 WebSocket，且已因事件循环卡顿
   配了 `loopWatchdog` + `autoheal`（卡住即重启容器）——实时连接与聊天写量压进去是已知会翻车的方向；
   relay 是「1:1 隧道且不解析 payload」，做群组会把业务语义塞进一个刻意保持中立的组件。
   msgbus 与自建 relay 同域不同 path，**身份复用 ucas-proxy 的 JWT**。
2. **客户端进内核，不走插件。** IM 要常驻、要未读角标、要系统通知；而插件交互页面只在桌面本地
   工作区且随会话挂载（`UI_PLUGIN.md`），做不到常驻。插件只能当 UX 原型，不是产品路径。
3. **有一个硬前置**：企业网关必须先提供**员工可用的用户目录**——现在只有 admin 权限的
   `GET /api/admin/users`，且没有 `/api/me`。没有花名册就无法选人建单聊，这是 P0 的第一个阻塞项，
   且它属于 ucas-proxy 侧改动（独立仓库、独立发布流程）。
4. **第一版不做**：逐条已读回执、语音/视频、端到端加密、外部联系人、表情回应、消息搜索。

> 状态：规划稿，尚未实现。事实核对基于 UWork `origin/uwork` = `c898562c`（2026-10-16）与本地
> `chore/upstream-v3.15.1-sync` = `62d1155f`；ucas-proxy `main` = `406e77e`（2026-10-09）。

## 一、功能范围

| 能力     | 第一版（P0） | 说明                                                                  |
| -------- | ------------ | --------------------------------------------------------------------- |
| 单聊     | ✅           | 两人 DM；重复发起幂等（同一对用户只有一个会话）                       |
| 群聊     | ✅           | 建群、拉人、退群、改群名；成员上限不设硬限但默认建议 ≤ 200            |
| 频道     | ⏳ P1        | `kind='channel'`：组织/团队内的主题流，可只读公告；与群共用同一套模型 |
| 消息     | ✅ 文本      | `kind`: `text`；消息 append-only，编辑/撤回留 tombstone               |
| 未读     | ✅           | 每成员一行 `last_read_seq`（**不做逐条已读**，写放大差一个数量级）    |
| 历史漫游 | ✅           | 按 `seq` 正序增量 + `before` 反向分页                                 |
| 多端同步 | ✅           | 同一用户多连接（桌面 + 手机），按 user 扇出                           |
| 附件     | ⏳ P1        | 图片/文件走对象存储，**不要把 blob 塞进 SQLite**                      |
| 通知     | ✅ 应用内    | 桌面用现有通知通道；移动端兜底见 P2                                   |
| 搜索     | ⏳ P1        | 会话内搜索                                                            |

## 二、服务端：msgbus

### 2.1 为什么是新服务

| 候选                        | 结论 | 依据                                                                                                                                                            |
| --------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ucas-proxy 内加             | ❌   | Express + 同步 better-sqlite3 单进程；`loopWatchdog` + autoheal 表明事件循环卡顿已在生产发生过；单实例无横向扩展；`authenticate` 只认 Bearer 头，无 WS 鉴权路径 |
| relay（web-remote-control） | ❌   | 语义是「device/terminal 1:1 配对 + 不解析 payload」；群组/持久化会破坏它的中立性。它继续负责「手机 ↔ 我的桌面 agent」这类 1:1 隧道                              |
| 新建 msgbus                 | ✅   | 连接、存储、限流自己扛；只复用 ucas-proxy 的 JWT 与组织模型                                                                                                     |

### 2.2 数据模型（SQLite WAL 起步）

```sql
conversations(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'dm' | 'group' | 'channel'
  title TEXT,                      -- group/channel 名；dm 不用（前端显示对方名字）
  created_by TEXT NOT NULL,
  dm_key TEXT,                     -- dm 专用：两个 user_id 排序拼接，保证同对用户唯一
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME, updated_at DATETIME
);
-- UNIQUE(org_id, dm_key) WHERE dm_key IS NOT NULL

conversation_members(
  conversation_id TEXT, user_id TEXT,
  role TEXT DEFAULT 'member',      -- 'owner' | 'member'
  last_read_seq INTEGER DEFAULT 0,
  muted INTEGER DEFAULT 0,
  joined_at DATETIME, left_at DATETIME,   -- left_at 支持退群/被移除，保留历史
  PRIMARY KEY (conversation_id, user_id)
);

messages(
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,            -- 会话内单调递增，IM 的硬要求
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'text' | 'attachment' | 'system'
  body TEXT NOT NULL,
  client_msg_id TEXT,              -- 发送方生成，幂等去重
  created_at DATETIME, edited_at DATETIME, deleted_at DATETIME
);
-- UNIQUE(conversation_id, seq)；UNIQUE(conversation_id, sender_id, client_msg_id)
```

- **seq 分配必须在写事务内**：`BEGIN IMMEDIATE` → `UPDATE conversations SET last_seq = last_seq + 1
… RETURNING last_seq` → 插消息 → `COMMIT`。SQLite 单写者、WAL 读不阻塞写；**写路径批量提交**，
  不要长事务（ucas-proxy 的教训）。
- 附件表 P1 再加（`attachments(id, message_id, blob_key, mime, size, sha256)`）。

### 2.3 协议

**WS（长连接，用于实时投递）**：`GET /ws`

- 连接后**首帧鉴权**：`{type:"auth", token}` → `{type:"ready", userId, serverTime}`。
  令牌**不放 URL**（会进 nginx/代理日志）。
- 上行：`{type:"send", conversationId, clientMsgId, kind, body}`；
  下行：`{type:"message", conversationId, message}`；
  回执：`{type:"sent", clientMsgId, message}`（客户端据此把"发送中"置为"已发送"）。
- 心跳 30s ping/pong；断线重连后用 REST `since` 补洞，客户端按 `message.id` + `client_msg_id` 去重。
- 多端：一个 user 可有多个连接，投递按 `user_id` 扇出到其全部连接。

**REST（拉取与写操作）**：

| 方法        | 路径                                                  | 用途                                                                               |
| ----------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GET         | `/api/conversations`                                  | 会话列表（含 `last_read_seq` / `last_seq` / 最后一条消息，未读数由前两者相减得到） |
| POST        | `/api/conversations`                                  | 创建 dm/group（`kind` + `memberIds`；dm 幂等返回既有会话）                         |
| GET         | `/api/conversations/:id/messages?since=<seq>`         | 增量补洞（正序）                                                                   |
| GET         | `/api/conversations/:id/messages?before=<seq>&limit=` | 历史分页（反向）                                                                   |
| POST        | `/api/conversations/:id/read`                         | 上报 `last_read_seq`（取 max，防回退）                                             |
| PATCH       | `/api/conversations/:id`                              | 改群名等                                                                           |
| POST/DELETE | `/api/conversations/:id/members[/:userId]`            | 拉人 / 移除 / 退群                                                                 |
| GET         | `/api/directory/users`                                | **企业网关侧新增**（见 §2.5）                                                      |

WS 只做投递与实时事件；**所有状态都能从 REST 重建**——这样离线、重连、冷启动都不依赖长连接是否稳定。

### 2.4 鉴权与组织隔离

- HTTP 用 `Authorization: Bearer <JWT>`（ucas-proxy 签的 `{userId, orgId, role}`）；WS 用首帧 auth。
- **每个查询带 `org_id` 硬约束**，成员校验在服务端做（不是前端过滤）。内部 UUID 为主键，
  `wecom_userid` 可猜、不作键——照抄 ucas-proxy 的隔离测试范式（`orgIsolationGuards.test.ts`）。
- 一期只允许组织内会话；跨组织（哪怕同名部门）一律拒绝。

### 2.5 硬前置：员工目录端点（在 ucas-proxy 侧）

单聊要先能选人，而现在**员工拿不到任何用户列表**（只有 `GET /api/admin/users`，admin 权限；
前端把个人资料缓存在 localStorage，也没有 `/api/me`）。需要在 control-plane 新增：

```
GET /api/directory/users?q=<可选搜索>       # 仅本 org，返回 id/name/avatar/department/position
```

字段在 `users` 表里已经齐（`config/database.ts:40-55`），不需要新表；要点是**权限收敛**：
只返回本组织、不含 `wecom_userid`/email 等可用于外部枚举的字段、支持按姓名/部门搜索。
这属于 ucas-proxy 独立仓库的改动，走它自己的发布流程。

### 2.6 部署形态：并入已有的 ucas-proxy 部署单元（同机、同 nginx、独立容器）

已核对的既有形态（`docker-compose.yml`、`nginx/nginx.conf`）：7 个服务（new-api / postgres /
audit-proxy / control-plane / mcp-gateway / autoheal / nginx），三段网络（`internal`（`internal: true`，
入向隔离）、`edge`（nginx 与对外服务）、`egress`（new-api 出网））；nginx 是唯一对外的容器，
且 `location /` 与 `/newapi/` 已经转发 `Upgrade`/`Connection`
（`nginx.conf:142-143, 211-212, 259-260, 319-320`）。

**结论**：msgbus 作为**同一台机器上的独立服务**（进同一个 compose 就是第 8 个服务，或同机独立 compose），
共用 nginx、证书与部署流程；但**独立容器、独立进程、独立数据库**，身份只复用 `JWT_SECRET`
（`auth/jwt.ts` 的 `signToken/verifyToken`，payload `{userId, orgId, role}`）。若放进 ucas-proxy 仓库，
还能直接 import `@ucas-proxy/shared` 的 `UserId/OrgId/Role` 类型。

**为什么不能与 control-plane 同进程（有事故为证，不是理论担忧）**：compose 里 control-plane 的 autoheal
注释记着 2026-09-09 的 SQLite pread D-state 冻结把整个 admin console 挂住，靠 autoheal 1–2 分钟自恢复。
对网关那是一次"控制台暂时打不开"；对 IM 就是**全员掉线 + 在线状态清零 + 推送积压**。加上
`better-sqlite3` 是同步单连接——聊天写路径会和 usageSync（30s 一轮）、console 聚合、审计查询争用
同一个连接。另外网关的 `authenticate` 只认 `Authorization` 头，WS 要首帧鉴权，属于新增旁路；
IM 的消息内容也比用量数据更敏感，放进同一个库等于继承同一批多组织越权风险。

**接线清单**：

1. **容器**：挂 `edge`（供 nginx 反代）；若连已有的 `postgres:16-alpine` 还需挂 `internal`
   （control-plane 就是 `internal` + `edge` 双挂）。
2. **nginx 是两层，这点最容易漏**：compose 里的 nginx 只是内层，它把应用入口监听在
   `127.0.0.1:23080-23082`（明文 HTTP；`docker-compose.yml` 的 nginx ports 注释写明"只绑回环，
   由公网反代转发"），宿主机上的外层反代（1Panel/openresty，见
   `docs/1panel-openresty-status-2026-08-26.md`）才终结 TLS 并对外。**两层都要做**：新增 location、
   补 `proxy_http_version 1.1` + `Upgrade`/`Connection`、调大 `proxy_read_timeout`。
   心跳间隔必须小于所有中间层的最小空闲超时（心跳 30s + 两层各 ≥ 90s 才稳）。
3. **身份**：同 `JWT_SECRET`；组织隔离从第一行代码就带 `org_id` 硬约束。
4. **目录端点** `GET /api/directory/users` 加在 control-plane（只读、轻量，放既有进程可接受）。
5. **发布解耦**：`docker compose -p ucas-proxy-prod up -d --build msgbus` 单独重建，不牵动网关的
   发布节奏（注意项目名必须带 `-p`，漏了会另起一套并行容器）。
6. **存储**：P0 用自带 volume 的 SQLite（零新依赖、贴合团队习惯），表结构别用 SQLite 特有语法；
   触发迁移到已有 Postgres 的信号是"需要跑两个实例（滚动更新不中断）"或写路径出现争用。
7. **入口是端口不是 443**（生产实测：`apiBaseUrl = https://pivot.ucas.com.cn:23090`，TLS 由外层
   反代终结，证书是 `*.keepsilent.xyz`）。三个后果：
   ① 桌面端能用（现有登录流程已经在用这个入口），**浏览器页面不能**——用 `pivot.ucas.com.cn`
   访问会主机名不匹配被拒，手机页必须走证书覆盖的名字（`*.keepsilent.xyz`）或另配证书；
   ② `pivot.ucas.com.cn` 解析到内网 `192.168.100.143`，**校外不可达**，手机端要么接受"仅校内可用"，
   要么另做公网入口（与 `specs/mobile-web-control-self-hosted.md` 的公网 relay 决策一起定）；
   ③ 非 443 端口在访客网络/公共网络上可能被防火墙拦。

**加固（自建就要自己扛）**：连接数上限、1 MiB 帧上限、心跳超时断开、Origin 校验、按 user/IP 限流、
消息体长度上限、单会话成员上限——清单照抄 `specs/mobile-web-control-self-hosted.md` §4.2。

**endpoint 下发**：用运行时配置（参照 `config/enterprise-identity.json` 的加载方式），不要只靠环境变量
——与 `mobile-web-control` 的 P3 结论保持一致。

## 三、客户端（UWork 内核）

| 层        | 位置                                                                              | 职责                                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 协议      | `packages/shared/src/im.ts`（新）                                                 | 类型单一来源：会话/消息/WS 信封；两套实现（桌面、手机）都从这里取                                                                                                              |
| 服务      | `packages/services/src/im/`（新）                                                 | `IImService` + `ServiceChannels.Im`；方法 `listConversations / openConversation / sendMessage / markRead / createDm / createGroup`，事件 `onMessage` / `onConversationUpdated` |
| 主进程    | `packages/desktop/src/main/im/`（新）                                             | WS 客户端：连接、首帧 auth、心跳、退避重连、`since` 补洞、离线发送队列。**照抄 `webRemoteControlTransport.ts` 的重连/心跳/帧上限模式**（它已经过真机打磨）                     |
| UI        | `packages/ui/src/im/`（新） + `workspaceSidePane.ts:530` 的 union 加 `"messages"` | 会话列表 + 消息时间线 + 输入框；渲染分派在 `app-shell/AnimatedSidePanePanel.tsx`；`selection-side-chat` 是同类面板先例                                                         |
| 通知/角标 | 复用 `PlatformChannels`                                                           | 未读角标 `SyncWindowUnreadCount`（`channels.ts:263`）；新消息通知 `ShowTaskNotification`（`:404`）                                                                             |
| 手机      | `packages/ui/src/WebRemoteControlMobileShell.tsx` 加第三页（P2）                  | 手机页只维护一份独立站点（`mobile-web-control-self-hosted.md` §7.6）                                                                                                           |

服务层放在 `packages/services` 而不是直接写在 UI 里，是为了让手机页与未来的 agent provider 复用同一套
读写逻辑（bot provider 也走 REST + WS，见 P2）。

**P0 验收**：两台机器上两个账号互相单聊、建群三条消息往返；断网 30 秒重连后消息**不丢不重**；
未读数与 `last_read_seq` 一致；冷启动能完整重建会话列表。

## 四、分期与灰度

**灰度范围（2026-10-16 定）：北京组织 + 部门白名单——一期只开放「测试与服务保障部」。**
生产只读核对：北京 `org_id=a1d155cb-7e9f-46ef-babb-ac296faac7a0`，205 个用户 / 197 个活跃 Key
（南京 24、厦门 29，另有一行 admin 组织）；`users.department = '测试与服务保障部'` 的行是
**14 条**，且北京只有这一个部门名含"测试"。205 人的量级让 §2.2 的单实例 SQLite 余量很大，P0 不需要
为容量做任何特殊设计；14 人的试点规模意味着**门禁的正确性比性能重要得多**。

**两级门禁**：org 白名单（`IM_ENABLED_ORG_IDS=beijing`）+ 部门白名单
（`IM_ALLOWED_DEPARTMENTS=测试与服务保障部`），后者才是真正的准入。

**配置与匹配（三处复用同一个判定函数）**：

```
IM_ENABLED_ORG_IDS=beijing
IM_ALLOWED_DEPARTMENTS=测试与服务保障部     # 逗号分隔，可列多个部门
IM_ALLOWED_USER_IDS=                        # 可选：内部 uuid 或 wecom_userid，给不在该部门的人显式开白
```

- 判定：把 `users.department` 按 `/[,，、;；]/` 切分 → trim → **按 token 精确相等**匹配白名单；
  命中 `IM_ALLOWED_USER_IDS`（内部 id 或 `wecom_userid`）也放行。
- **不做整串比较、也不用 `LIKE '%测试%'`**：多部门时 `department` 会写成
  `"总经办, 市场营销部"` 这种逗号串（北京有 4 行），整串比较会漏人，模糊匹配会误放。
- 白名单必须与 org 绑定（同名部门可能在别的组织也存在）；一期靠 `IM_ENABLED_ORG_IDS` 先兜住。
- 建议用 `IM_ALLOWED_USER_IDS` 显式给管理员/演示账号开白，**不做角色隐式放行**——否则会出现
  "为什么管理员能进我不能"的意外。

**三个执行点（客户端只是渲染，服务端才是权限）**：

1. **目录**（control-plane `GET /api/directory/users`）：调用者不在白名单 → 403；返回集合 = 白名单
   内的人。于是**你能聊的人 = 能聊你的人**（对称），不会出现单向可见的怪状态。
2. **msgbus（权威）**：WS 首帧鉴权、建会话、加成员、发消息四处都校验，且**校验会话全体成员**都在
   白名单内；失败返回 403 并记日志。
3. **客户端**：`GET /api/im/entitlement`（放在 control-plane，客户端已有到网关的连接，不必新开链路）
   返回 `{enabled:false}` 时不渲染 IM 入口；下发走运行时配置。

**两个会静默失效的运维陷阱**：

- **部门名是显示串**：企微里改名后 `users.department` 会被下次登录/同步覆盖 → 白名单静默失配 →
  **所有人同时失去 IM**。对策：msgbus 启动时打印 `IM allowlist matched N users`，**N=0 时 WARN 并
  拒绝提供 IM 服务**（fail loud，别静默变成空功能）；改名要同步改 `.env` 并重启两个容器。
- **`department` 有两个写入源**（登录时 `upsertFromWeCom` 刷新 + 管理员 `setDepartment` 手改），
  判定要用读时的当前值，不要长期缓存。

**验收（14 人试点）**：测试与服务保障部的用户能看到入口、目录里只有这 14 人、能互发单聊与建群；
非白名单用户入口不渲染、直连 `GET /api/directory/users` 得 403、手工连 msgbus 的 WS 鉴权失败；
`"总经办, 市场营销部"` 这类多部门行（北京 4 人）必须被正确拦下——这是防误放的现成样本。

**升级路径**：部门多起来后应把白名单从"部门名"换成企微部门 ID（数字）。现在 `users` 只存了名字
（`wecom.ts` 的 `getDepartmentNames` 把 `number[]` 换成了名字），需要加列或加表并改 `wecom.ts` /
`directorySync`。14 人试点用名字够用，但上面三条（token 精确匹配、与 org 绑定、fail loud）必须做到。

**"只做北京 + 只做测试部"是灰度范围，不是架构简化**：`conversations` / `conversation_members` /
`messages` 仍然每行带 `org_id`，每条查询仍然强制 org 约束。这是 ucas-proxy 那批越权缺口的直接教训
——它们几乎都源自"反正只有一个组织/一个域名"的假设。收窄范围靠加开关，不是去掉隔离。

**北京组织的三个特定约束**（均为生产事实）：

1. **用户池 = 北京企微应用的可见范围**：北京应用是**标签授权（20 个部门）**，`directorySync` 的
   注释明确写着"在该组织口径里这就是在职名单"。一期 `GET /api/directory/users` 返回的是其中被白名单
   命中的 14 人。
2. **企微应用消息的可见范围**：P2 的离线推送用北京 `agentId=1000083` 与其 secret，
   **推送目标必须在该应用的可见范围内**，否则企微侧会拒——它决定了"哪些人能收到离线提醒"。
3. **用户目录要与离职对账口径一致**：`directorySync`（每天 03:30，report/enforce 两模式）已有在职
   判定；IM 的用户目录不能只按 `users` 表取（表里可能留着已离职账号），否则会出现"给离职的人建会话"。
   离职自动退群同理挂在这条线上（P3）。

### P0 基础可用（服务端最小 + 目录端点 + 桌面单聊/群聊）

- msgbus：`conversations` / `conversation_members` / `messages`、WS 投递、REST 拉取与补洞、鉴权与 org 隔离。
- ucas-proxy：`GET /api/directory/users`（独立仓库，需单独排期与发布）。
- 客户端：服务层 + 主进程 WS 客户端 + side-pane 面板（单聊、建群、文本、未读）。

### P1 完整性

频道（`kind='channel'`，与群共用模型）、附件（对象存储 + 直传）、会话内搜索、通知打磨
（免打扰、@提醒）、消息 tombstone 的编辑/撤回语义。

### P2 差异化与移动端

- **agent 作为成员**：`packages/services/src/bots/providers/` 新增 native `uwork` provider，
  把「频道/话题」映射成语用 `[botId, chatId, threadId]` 的会话键（`groupSessions.ts:4-17`），
  直接复用已验证的 @解析、流式回复、任务结果投递与话题续接。`docs/bots.md:197` 早已把
  Discord/WeCom 列为预留 provider，模式一致。
- 手机页第三页 + 企微应用消息兜底（`message/send` + `touser`，现状只有群机器人 webhook）。

### P3 治理

保留策略与合规导出、审计/DLP 接入、群管理权限（谁能建频道、成员上限、离职自动退群
——后者可挂现有 `directorySync` 的离职对账）。

## 五、需要拍板的决策点

1. **msgbus 放公网还是内网**：决定"手机/校外是否可用"与加固清单的严格程度（一期若只办公网内使用，可先内网）。
2. **移动端形态**：Web + 企微推送兜底（最快）还是 Android 壳（`packages/android` 已有骨架）先做。
3. **是否需要"已读"**：建议只做 `last_read_seq` 未读，不做逐条已读回执。
4. **组织边界（已定）**：一期只对北京开放（见 §4 灰度范围），跨组织会话不做；南京/厦门登录后
   不渲染 IM 入口。
5. **服务端起步存储**：SQLite WAL（快）还是直接 Postgres（省一次迁移）。

## 六、风险与对策

| 风险                                   | 对策                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 无推送时移动端体验缺口                 | 一期用企微应用消息兜底；桌面端本来就是常驻进程，通知够用                                                                            |
| 把 ucas-proxy 的单进程卡顿教训复制过来 | msgbus 独立进程；写路径批量提交；压测后再谈扩容                                                                                     |
| fork 上游同步冲突                      | 新文件为主（`shared/src/im.ts`、`services/src/im/`、`desktop/src/main/im/`、`ui/src/im/`），接缝只改 side-pane union 与渲染分派两处 |
| 多组织越权                             | 服务端强制 org 约束 + 成员校验；隔离测试与 ucas-proxy 同范式                                                                        |
| 数据出境                               | 自建 msgbus 使消息不出境；同时复核 `mobile-web-control-self-hosted.md` 的出境清单                                                   |
| 目录端点被滥用枚举                     | 只返回本 org、最小字段、按姓名搜索需登录态与频率限制                                                                                |

## 七、本次未验证 / 实现时需确认

- `better-sqlite3` 在 msgbus 写路径上的并发上限（需压测；P0 单组织量级预期够用）。
- WS 在办公网代理/防火墙下的连通性（公网部署必须 443 + wss）。
- ucas-proxy 侧目录端点的权限模型细节（是否要给"仅本部门可见"等选项）。
- 手机页第三页与实际 UI 壳的耦合度（`WebRemoteControlMobileShell` 的页面状态机是否适合挂 IM）。
- 若引 Centrifugo：它的 history 是**有界缓存不是消息存储**，永久历史仍必须落在自己的库里；
  多节点需要 Redis，是否值得为 P0 引入要按并发规模判断。
- 若引 ntfy 做推送：iOS 的即时送达依赖 APNs，自托管实例需要配置 `upstream-base-url` 指回官方
  `ntfy.sh`（消息会经官方服务器一跳），Android 走自己的长连接不受影响——上线前需按目标机型实测。

## 八、参考实现（活跃度与许可均于 2026-10-16 用 GitHub API 核对）

先分清三种「参考」的含义：**整包当服务端**、**只引实时层/推送层**、**只抄协议与数据模型**。
三者的代价差一个数量级，混着选是这类项目最常见的翻车方式。

| 项目                                                                         | 语言        | 许可         | 活跃度                                  | 对 UWork 的定位                                                                                                          |
| ---------------------------------------------------------------------------- | ----------- | ------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`centrifugal/centrifugo`](https://github.com/centrifugal/centrifugo)        | Go          | Apache-2.0   | 10.9k★，2026-10-14                      | **推荐直接引**：自托管实时层（WS/SSE 订阅、history、presence、JWT 鉴权、Redis 多节点）。自研只留会话/成员/消息持久化     |
| [`binwiederhier/ntfy`](https://github.com/binwiederhier/ntfy)                | Go          | Apache-2.0   | 34.9k★，日更                            | **推荐直接引**：自托管推送，Android/iOS 有官方 App，绕开国内 FCM 不可用；补 §2 里"移动端推送"的短板                      |
| [`element-hq/synapse`](https://github.com/element-hq/synapse)                | Python+Rust | AGPL-3.0     | 4.7k★（旧 `matrix-org/synapse` 已归档） | Matrix 官方 homeserver。**抄同步协议**：`/sync` 的 since token、`m.read` / `m.fully_read`；整包太重                      |
| [`element-hq/element-web`](https://github.com/element-hq/element-web)        | TS          | AGPL-3.0     | 13.6k★                                  | 多端同步与未读状态的 UI 参考                                                                                             |
| [`zulip/zulip`](https://github.com/zulip/zulip)                              | Python      | Apache-2.0   | 26.1k★                                  | **抄模型**：stream + topic 两级结构，是"频道 + 话题"最成熟的设计，也正好是 agent 派活的粒度                              |
| [`mattermost/mattermost`](https://github.com/mattermost/mattermost)          | TS + Go     | MIT + 企业版 | 39.4k★                                  | **抄 API 形状**：REST 分页 + WS 事件命名（`posted` / `channel_viewed` / `typing`）。整包会把"替代企微"变成"再造一个平台" |
| [`RocketChat/Rocket.Chat`](https://github.com/RocketChat/Rocket.Chat)        | TS          | MIT + 企业版 | 46.3k★                                  | 同上，Node 栈但 Meteor/Mongo 重心与 UWork 不同                                                                           |
| [`tinode/chat`](https://github.com/tinode/chat)                              | Go          | GPL-3.0      | 13.5k★，2026-10-10                      | **整包备选**：带 iOS/Android/Web 客户端与 chatbot，协议文档完整；代价是第三套技术栈 + 账号体系适配                       |
| [`openimsdk/open-im-server`](https://github.com/openimsdk/open-im-server)    | Go          | Apache-2.0   | 16.7k★，日更                            | **整包备选**：中文生态、多端 SDK 与推送齐全，最接近"微信式"能力面                                                        |
| [`wildfirechat/im-server`](https://github.com/wildfirechat/im-server)        | Java        | 混合         | 8.6k★                                   | 国内企业常用整包（野火 IM），同类取舍                                                                                    |
| [`msgbyte/tailchat`](https://github.com/msgbyte/tailchat)                    | TS          | Apache-2.0   | 3.6k★                                   | **TS 参考实现**：插件化 Discord-like，代码可读，适合当"TypeScript 怎么写频道/成员/权限"的样本                            |
| [`stoatchat/stoatchat`](https://github.com/stoatchat/stoatchat)（原 Revolt） | Rust        | 混合         | 3.4k★，日更                             | 开源 Discord 复刻，权限/频道模型可参考；成熟度中等                                                                       |
| [`processone/ejabberd`](https://github.com/processone/ejabberd)              | Erlang      | GPL-2.0      | 6.7k★                                   | XMPP 栈（MAM 归档、多端 carbons、推送 XEP），极稳但生态老旧、团队要学 Erlang                                             |
| [`spacebarchat/server`](https://github.com/spacebarchat/server)              | TS          | AGPL-3.0     | 2.2k★                                   | Discord 兼容 API；成熟度不足，不建议                                                                                     |
| [`discourse/discourse`](https://github.com/discourse/discourse)              | Ruby        | GPL-2.0      | 48k★                                    | 论坛 + Chat，方向不符                                                                                                    |
| [`yinxin630/fiora`](https://github.com/yinxin630/fiora)                      | TS          | MIT          | 7.2k★，**最后提交 2024-02**             | 已停止维护，不要选                                                                                                       |

**推荐组合（与 §2、§3 的方案一致）**：会话/成员/消息的持久化与 UWork 集成自研，
实时层用 Centrifugo，推送用 ntfy，协议抄 Matrix 的 `/sync`（since token）与 Zulip 的 topic 模型。
这样既不引入第三套技术栈和另一个产品，又不自己重写多端同步、连接治理与推送。

**整包路线成立的前提**：如果目标变成"公司要有一个自研 IM 平台"（而不是"IM 长在 UWork 里"），
那么 Synapse（协议正统、E2EE、Application Service 模型正好承载 agent 成员）或 OpenIM（中文生态、
推送与多端齐）是更省时间的起点——但要接受账号体系与 ucas-proxy JWT 的适配成本。

## 九、实现进度（2026-10-16 起）

### 已完成：服务端门禁 + msgbus 存储核心（代码在 ucas-proxy 仓库，未部署）

| 文件（ucas-proxy 仓库）                          | 作用                                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/control-plane/src/im/allowlist.ts`     | 三级白名单判定（org + 部门 + 用户）：部门按分隔符切分后**按 token 精确相等**；两白名单皆空 ⇒ fail closed；显式 `'*'` 才整组织开放                                    |
| `services/control-plane/src/im/registry.ts`      | 判定主体取数（含 org slug）、目录条目（带切好的 `departments`）、给 msgbus 的白名单快照（只含判定标识，不带姓名等 PII）                                              |
| `services/control-plane/src/routes/directory.ts` | `GET /api/directory/users`：白名单外 403；列表与调用者**对称可见**；支持 `q` 搜索                                                                                    |
| `services/control-plane/src/routes/im.ts`        | `GET /api/im/entitlement`（客户端渲染开关）与 `GET /api/im/internal/allowlist`（msgbus 拉快照；`IM_INTERNAL_TOKEN` 独立令牌，未配置返回 503 而不是放行）             |
| `services/msgbus/src/config/database.ts`         | 新服务的表结构（conversations / conversation_members / messages；seq 唯一索引；时间戳为 epoch 毫秒）                                                                 |
| `services/msgbus/src/store/messaging.ts`         | 存储核心：DM 幂等、会话内 seq 单调、`client_msg_id` 幂等、`since` 补洞、`before` 分页、未读=`last_seq-last_read_seq`、退群留痕、撤回 tombstone、跨组织按"不存在"处理 |
| `.env.example` / `docker-compose.yml`            | 新增 `IM_ENABLED_ORG_IDS` / `IM_ALLOWED_DEPARTMENTS` / `IM_ALLOWED_USER_IDS` / `IM_INTERNAL_TOKEN`（默认全空 = 不对任何人开放）                                      |

**验证记录（本次实际执行）**：

- control-plane 全量 `npx jest`：**39 套件 / 331 用例通过**，1 套件按设计跳过（需要生产库快照的 `prodDbGuards.verify`）。
- 新增用例：白名单单测 11 条 + 路由端到端 16 条，专门覆盖三条关键防线——多部门串（`"总经办, 市场营销部"`）不误放、跨组织同名部门被组织门禁拦下、白名单皆空时 fail closed；另测快照 `matchedCount=0` 供 msgbus fail loud。
- msgbus `npx jest`：**22 条通过**；`tsc --noEmit` 干净；shared / control-plane / msgbus 三个 workspace 的 `npm run build` 均通过。
- **未执行**：任何部署动作（未构镜像、未碰生产、未改 nginx）；UWork 客户端尚未动工。

### 实现中定型的两处设计（与初稿不同）

1. **msgbus 不读 control.db**：白名单由 control-plane 经 `/api/im/internal/allowlist` 以**快照**下发，msgbus 本地缓存判定——既不跨容器共享 SQLite 文件，也不在每条消息上打一次 HTTP。快照带 `matchedCount`，为 0 时 msgbus 必须 fail loud（WARN + 拒绝提供 IM 服务）。
2. **时间戳存 epoch 毫秒**：SQLite `CURRENT_TIMESTAMP` 只到秒，同一秒内更新的两个会话在"最近会话"排序里会抖动（实现时被测试抓到）。store 支持注入时钟，测试因此可以精确控制"谁更近"。

### 第二轮（同日）：HTTP + WS 层与部署接线

| 文件（msgbus）                                       | 作用                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/auth/allowlist.ts`                              | 白名单快照缓存：周期从 control-plane 拉取；**三条 fail loud**——首次拉不到就拒绝服务、快照命中 0 人就拒绝服务、刷新持续失败超过 `IM_ALLOWLIST_MAX_STALE_MS` 就拒绝服务（未超时则继续用最后一份好快照，避免网络抖动让 IM 整体不可用） |
| `src/auth/identity.ts`                               | JWT（复用 `JWT_SECRET`）+ 白名单门禁；**403 与 503 分工**：403 = 明确不在名单（客户端不渲染入口），503 = IM 暂不可用（客户端提示稍后重试）                                                                                          |
| `src/routes/conversations.ts`                        | REST 面 9 条：会话列表/建会话/拉消息(`since`/`before`)/发消息/已读/改名/加人/退群/撤回；**会话全体成员都必须在白名单内**（防把灰度外的人拉进来）                                                                                    |
| `src/ws.ts`                                          | 首帧 `auth`（令牌不放 URL）、心跳 30s、1 MiB 帧上限、自定义关闭码 4400/4401/4403/4503；只做投递，正确性在 store                                                                                                                     |
| `src/hub.ts`                                         | 用户→多连接映射（同一用户多端在线），按会话成员扇出                                                                                                                                                                                 |
| `src/app.ts` / `src/index.ts`                        | 装配与启动；`/health` 只看进程存活（白名单失配不该被 autoheal 反复重启掩盖，状态放在响应体里）                                                                                                                                      |
| `services/msgbus/Dockerfile` + compose `msgbus` 服务 | 独立容器 + `msgbus-data` 卷；只挂 `edge`（nginx 反代 + 访问 control-plane 拉快照）                                                                                                                                                  |

**验证记录（本轮实际执行）**：

- msgbus `npx jest`：**4 套件 / 50 用例通过**（存储 22、快照缓存 7、REST 11、WS 10），覆盖 DM 幂等、seq 单调、`client_msg_id` 幂等、`since` 补洞、跨组织 404、非成员 403、撤回 tombstone、WS 关闭码语义、以及"白名单不可用时 503 而不是放行"。
- `tsc --noEmit` 与 `npm run build` 通过；`docker compose config` 解析通过。
- **进程级 smoke（真进程 + 真实 SQLite 文件 + 存根 control-plane）**：启动即拉到快照（命中 2 人）→ `/health` 报 `allowlistUsers: 2` → 建单聊返回会话 → 发消息 `seq=1` → 会话列表 `unreadCount=1` → 白名单外 403 → 无令牌 401；`msgbus.db` 与 `-wal`/`-shm` 正常落盘（WAL 生效）。
- **仍未执行**：nginx 接线（msgbus 目前只在 docker 网络内可达，属预期）、任何部署动作、客户端实现。

### 第三轮（同日）：UWork 客户端协议与服务层

| 文件（UWork 仓库）                         | 作用                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/im.ts`                | 协议单一来源：会话/消息/通讯录/准入类型、WS 客户端帧与服务端帧（**用 zod 校验**，认不出的帧丢弃）、`IM_CLOSE_CODES`、`buildImWsUrl()` |
| `packages/services/src/im/contract.ts`     | `IImService` 契约 + `ServiceChannels.Im` descriptor；`ImView` 的 `entitlement: null` 表示"还查不到"而不是"没权限"                     |
| `packages/services/src/im/imHttpClient.ts` | REST 面（9 条），403/503 语义原样上抛（`ImHttpError` 带 code）                                                                        |
| `packages/services/src/im/imTransport.ts`  | WS 连接管理：首帧 auth、心跳兼存活探针、指数退避重连、关闭码分派（4403 终态 / 4503 慢重连 / 4401 重取令牌）                           |
| `packages/services/src/im/imService.ts`    | 门面：准入 + 会话列表 + 消息缓存 + 未读 + 实时事件；发送"WS 优先、超时回退 HTTP"，两条路共用同一个 `clientMsgId`                      |
| `packages/services/test/im.test.ts`        | 14 条用例（连接 6 + 门面 8），用假 socket 与假 HTTP 客户端驱动                                                                        |

**注册点共 7 处**（比"新增服务改 4 处"的既有说法多，因为类型入口既要从 `index.ts` 再导出、又要声明子路径别名）：
`shared/package.json` 的 `exports["./im"]`、`shared/src/index.ts` 的再导出、`shared/src/channels.ts` 的
`ServiceChannels.Im`、`apps/zcode-cli/packages/cli/scripts/build.mjs` 的 alias 表、
`services/src/index.ts` 的导出、`services/src/node.ts` 的 `.register(IImService, …)`、
`client/src/remoteServiceAccess.ts` 的 ProxyChannel 代理。

**实现中定型的两处（都是被测试抓出来的）**：

1. **心跳探活不能每次 tick 重置 `lastPongAt`**：初版在每轮心跳里刷新它，"两个周期没 pong 就重建"的条件
   永远不成立——半开连接（对端消失但 TCP 未断）永远发现不了。现在只在鉴权完成与收到 pong 时更新，
   `lastPongAt` 才是真的存活时间戳。
2. **补洞发独立事件 `catch_up`，不冒充 `message`**：重连补回来的历史消息若按新消息广播，
   一次断线重连会给用户刷一屏通知。UI 对 `catch_up` 做静默插入。

**验证记录（本轮实际执行）**：

- `pnpm exec vitest run packages/services/test/im.test.ts`：**14/14 通过**，覆盖 auth 帧在 open 之后才发、
  心跳续命与超时重建、4403 不重连、4503 退避重连、脏帧被忽略、503 不等于没权限、在线走 WS、
  离线回退 HTTP 且带同一 `clientMsgId`、未读递增、补洞事件类型。
- `tsc --noEmit`：`packages/shared`、`packages/services`、`packages/client` 三包**全绿**
  （注意 `@zcode/shared` / `@zcode/services` 解析的是 dist，改完要先 `tsc -b` 重建再验 client）。
- `oxfmt --check`：改动文件全部符合格式（仓库硬约束）。
- **未执行**：桌面真机联调、UI 面板、desktop main 的 socket 注入（当前 `node.ts` 用运行时全局 WebSocket 兜底，
  Node 22+ 自带；桌面若要更稳可注入 `ws`）。

### 第四轮（同日）：UI 入口 + 默认背景与 AIHub 对齐

**IM 面板与入口**（UWork 仓库）：

| 文件                                                                                                               | 作用                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/im/useIm.ts`                                                                                      | 两个 hook：`useIm`（订阅 `onDidChange` + 取初值 + 进面板刷新一次）与 `useImConversation`（打开会话拉最新页、实时事件合并、`catch_up` 静默插入、撤回改 tombstone、向上翻页） |
| `packages/ui/src/im/MessagesSidePane.tsx`                                                                          | 面板：头部（连接状态徽标 + 发起单聊 + 刷新）、会话列表（未读角标）、通讯录选人、空/未开通/不可用三种状态分开显示                                                            |
| `packages/ui/src/im/ImConversationPanel.tsx`                                                                       | 时间线（气泡按 `selfUserId` 对齐、撤回留占位、时间用系统 locale 格式化）与输入框（Enter 发送 / Shift+Enter 换行）                                                           |
| `packages/ui/src/lib/workspaceSidePane.ts`                                                                         | 新增 `messages` tab 类型/union/`createMessagesSidePaneTab`/`openMessagesSidePane`；登记为**工作区全局 tab**（IM 不随会话生灭）                                              |
| `packages/ui/src/app-shell/*`、`WorkspaceSidebar*`、`App.tsx`、`hooks/useAppPanels.ts`、`services/src/accessor.ts` | 接线：渲染分派、tab 图标与标题、`handleOpenMessages` 一路从 `useAppPanels` 传到侧栏页脚的消息按钮；`IServiceAccessor` 暴露可选 `imService`                                  |
| `i18n/locales/{zh-CN,en-US}.ts`                                                                                    | 新增 25 个 `im.*` 文案（两套语言同步）                                                                                                                                      |

入口位置：侧栏页脚设置按钮左侧的「消息」按钮（`data-testid="sidebar-messages-button"`），点击打开/聚焦同一个面板。
`ImView` 增加了 `selfUserId`（由 WS 的 `ready` 帧带回），UI 用它对齐自己发的消息气泡。

**默认背景与 AIHub 对齐**：取值来源是 AIHub（SkillHub）前端的主题文件
`skills/skillhub/web/src/index.css`（"UCAS 黑白企业风：纯黑白反相，语义色仅表状态"）：

- 深色页底 `#0f0f0f`、面板 `#171717`（原先 UWork 默认主题 `zai-dark` 是 `#161616` / `#2b2b2b`）；
- 浅色页底 `#f5f5f5`、面板 `#ededed`（原 `#f8f8f8` / `#ececee`）。

改动点：`packages/ui/src/styles.css` 的 `.theme-zai-light` 与 `.theme-zai-dark` 两组 token、
`packages/web/index.html`（`theme-color`、启动壳主题常量与 CI 兜底色）、
`packages/desktop/src/renderer/index.html` 的启动闪屏渐变末端、设置页主题预览卡片的硬编码值。

> 注意：AIHub **线上**的 SkillHub bundle 还是旧品牌（紫），黑白风在仓库里（commit `5dec7eb` 之后）
> 但尚未部署；这里按仓库正在推的那套对齐，下次 SkillHub 部署后两边才完全一致。

**验证记录（本轮实际执行）**：

- `pnpm exec tsc --noEmit`：`packages/ui` 与 `packages/services` 中**本轮改动的文件零错误**
  （改动共享包后先 `tsc -b packages/services packages/shared` 重建 dist，否则下游会报假错）。
- `oxfmt --check`：改动文件全部符合格式。
- `vitest run packages/services/test/im.test.ts`：**14/14 通过**（`ImView` 新增字段未破坏契约）。
- 侧栏相关单测 **5 套件 / 62 条通过**（含本轮新增的 2 条回归，见下）。

**真机 Smoke 发现的崩溃（已修）**：首次运行时 `Cannot read properties of undefined (reading 'path')`。
根因是 `sidePaneTabPresentation.ts` 的 `getSidePaneTabSearchHint` **兜底分支**直接写
`return tab.source.path ?? tab.source.title`，而 `messages` tab 没有 `source` 字段 →
读 `undefined.path` 抛错、整棵 workspace 子树挂掉。

- **同一个坑这个仓库踩过第二次**：`getSidePaneTabTitle` 里还留着上一轮 browser-use 的同款注释。
  两处兜底现在都改成防御式（`if ("source" in tab && tab.source)`，否则给中性标题 `sidePane.unknown`），
  并补上 `messages` 分支（搜索提示 / 类型标签 / 标题三处）。
- **为什么类型检查没拦住**：本仓 `tsconfig.base.json` **没开 `strictNullChecks`**（只开了
  `noUncheckedIndexedAccess`），所以 `tab.source.path` 是合法 TS——这类崩溃只能靠运行或测试发现。
- **回归测试**：`packages/ui/test/sidePaneTabPresentation.test.ts` 新增 2 条——`messages` 三处展示可用；
  **完全未知的类型**兜底不抛错、只返回中性结果。这条钉住的是"未来再加 tab 类型不会重演"。

**仍未验证**：面板没有做完整的真机交互验证（单聊/群聊往返、断线重连补洞、未读角标）。
`packages/ui/test/*.e2e.mjs` 需要 browser-harness 在 Chrome 里手动允许远程调试，无人值守跑不了，
按仓库约定记为未验证——本次只做到"启动不再崩、侧栏展示三件套有测试"。

### 第五轮（同日）：生产上线（北京 + 测试部 + 三位负责人）

**上线内容**（全部在 ucas-proxy 生产 `192.168.100.143`，项目名 `ucas-proxy-prod`）：

- control-plane：新增 `im/allowlist.ts`、`im/registry.ts`、`routes/directory.ts`、`routes/im.ts`，`index.ts` 挂两条路由；
- msgbus：新容器（独立 SQLite `msgbus-data` 卷）；
- 内层 nginx：新增 `location /api/conversations` 与 `location /ws` → `msgbus:3010`（`/ws` 的 read/send timeout 600s）；
- `.env`：`IM_ENABLED_ORG_IDS=beijing`、`IM_ALLOWED_DEPARTMENTS=测试与服务保障部`（14 人）、
  `IM_ALLOWED_USER_IDS=xiaohua.xin,jingping.li,yueyang.lv`、`IM_INTERNAL_TOKEN`（新生成）→ 快照 **matchedCount=17**。

**外层反代不需要改**：1Panel 的 `pivot.ucas.com.cn:23090` 站点（`/opt/1panel/www/conf.d/pivot.ucas.com.cn.conf`
→ `sites/pivot.ucas.com.cn/proxy/root.conf`）本来就是 `location /` 直通 `127.0.0.1:23080`，
且已带 `proxy_read_timeout 600s` 与 `Upgrade`/`Connection` 转发——两层 WS 的 timeout 都够。
客户端的 `wss://pivot.ucas.com.cn:23090/ws` 因此直接生效。

**验证记录（生产实测，逐条执行）**：

- 回退探针 `POST /api/auth/handoff/start` = **201**（确认 control-plane 重建没有回退既有功能）；
  `auth/orgs`=200、`health`=200；
- 新路由存在且要鉴权：`/api/directory/users`、`/api/im/entitlement`、`/api/im/internal/allowlist` 无令牌均 **401**；
- 白名单快照 `matchedCount=17`，msgbus 日志 `白名单快照就绪：命中 17 人`；
- 经外网入口 23090：`/api/im/entitlement` → `{"enabled":true,"via":"user"}`（辛晓华），`/api/conversations` → `{"conversations":[]}`；
- **WS 经 nginx 握手拿到 `{"type":"ready",...}`**（在 msgbus 容器内连 `ws://nginx:80/ws`）；
- 非白名单用户 → `{"enabled":false,"reason":"not_in_allowlist"}`；
- `docker ps` 8 个服务、无多余容器；网关自身全部正常。

**两个上线坑（都踩到了，记在这里省下次的时间）**：

1. **`nginx.conf` 是单文件 bind mount，绑的是 inode**：用 tar/替换方式更新宿主机文件后，容器里看到的
   仍是旧 inode（`grep msgbus` 计数 0），`nginx -t` 与 `reload` 都会"成功"但配置其实没生效。
   → 更新单文件挂载的配置后必须 `docker compose -p ucas-proxy-prod restart nginx`。
2. **msgbus 首拉快照会失败**：与 control-plane 同批 `up -d` 时，msgbus 先起来，日志报
   `白名单快照首次拉取失败 { message: 'fetch failed' }` → 这是启动次序而非配置问题，按 TTL 重试即恢复
   （重启 msgbus 可立即拉取）。日志刻意区分"首次失败"与"继续用旧快照"两种措辞。

**回滚**：改动前的 5 个文件备份在 `/home/services/ucas-proxy/backups/im-20261017-011848/`；
只想关掉 IM 而不回退网关：`docker compose -p ucas-proxy-prod down msgbus`（前端会显示"不可用"），
或把 `.env` 的 `IM_ALLOWED_DEPARTMENTS`/`IM_ALLOWED_USER_IDS` 清空 = fail closed（谁都不放行）。
**注意：生产不是 git 检出**，本地仓库的改动仍未提交（两个仓库都没有 commit）。

### 第六轮（同日）：消息撤回

服务端本来就有（store 的 `deleteMessage`：只有发送者能撤回、置 `deleted_at` 并清空正文 = tombstone；
REST `DELETE /api/conversations/:id/messages/:messageId` 成功后向会话成员广播 `message_deleted`）。
本轮补的是**触发入口与更新路径的一致性**：

- **服务层**：本地撤回也发同一条 `message_deleted` 实时事件。UI 因此只有一条更新路径
  （自己撤回、另一台设备撤回、别人撤回都是它）；否则"自己撤回"要在每个组件各打一次补丁，迟早漏一处。
- **UI**：自己发的、未撤回的消息，悬停时出现「撤回」；**两步确认**（第一次点击变成「确认撤回」）——
  正文清空后不可恢复，防误点；失败时在输入框上方就地提示，不静默吞掉。

验证：服务层测试 **16 条**（新增两条：撤回成功后发事件；撤回失败向上抛且本地状态不变）；
生产用不存在的 id 探 `DELETE /api/conversations/.../messages/...` → 结构正确的 **404**
（证明撤回这条路经外层 23090 已通到 msgbus，且没有写入任何数据）。

**未定项**：撤回是否要时间窗（微信是 2 分钟）。服务端目前允许发送者随时撤回；要加只是
`deleteMessage` 里一条时间判断——这是产品决策，不是技术限制。

### 第七轮（同日）：撤回改为"服务端留痕" + 容量实测

**产品决策反转（负责人口径："不要清空，服务端还是要保留痕迹"）**：

- 库里**保留原文**（`deleted_at` 只作标记），所有对外读路径在 `toMessage` 里把正文清空 →
  客户端（包括发送者自己）一律只看到「已撤回」。顺手把重复撤回改成幂等（不刷新时间戳）。
- 代价要写清：撤回在**取证意义上不再不可恢复**——能登这台机器的人可以读到原文。
  这是刻意的取舍（组织内部工具通常要求可追溯）。若将来既要留痕又要防取证，需要列级加密或分权读取（P3 治理）。
- 生产已重建 msgbus 并验证：库里 `body` 保留、对外下发 `body` 为空、`deleted_at` 已置。

**容量实测**（在生产 msgbus 容器里跑**真实 store**，最坏情况：把一半流量打在全公司 205 人频道上）：

| 指标                        | 实测值                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| 写入吞吐                    | **约 3,050 条/秒**（20,000 条用 6.5 秒）                                |
| 单条写入延迟                | p50 0.22ms / p95 0.30ms / p99 5ms / max ~20ms                           |
| 会话列表                    | 0.15ms/次                                                               |
| 拉最近 50 条 / `since` 增量 | 0.22ms/次                                                               |
| 205 人群取成员              | 0.12ms/次                                                               |
| 存储                        | 约 **345 字节/条** → 205 人 × 50 条/天 ≈ 3.4 MiB/天，一年约 **1.2 GiB** |
| `synchronous`               | 已是 NORMAL（WAL 推荐值），无需再调                                     |

**结论：200 人这个量级离 SQLite 上限还差两个数量级**——205 人日均约 0.12 条/秒，峰值按百倍算也就
~12 条/秒，是实测容量的 0.4%。换 Postgres 的触发条件**不是吞吐**，而是：

1. 需要跑**两个实例**（零停机发布 / HA）；
2. 需要把库放共享存储或跨机；
3. 持续写入超过 **~300 条/秒**（容量的 10%，留安全边际）；
4. 要在同一个库上跑报表/分析查询（会挡写；现在没有这种需求）。

迁移成本：store 层是纯 SQL + better-sqlite3 的同步 API，换 pg 要把它改成异步（`IImService` 本来就是
async，改动面集中在 store 与其测试），表结构可平移（没用到 SQLite 特有语法），约一天工作量。

### 第八轮（同日）：存储从 SQLite 迁到 PostgreSQL（生产已切换）

**为什么换**（负责人口径）：SQLite 用同步驱动会占住事件循环——与 control-plane 那次冻结事故同一类风险；
且单文件单实例，做不了多实例与零停机发布。换异步驱动后 DB 等待不再阻塞事件循环，同时具备 HA 空间。
实测吞吐（3,050 条/秒 vs 需求 ~12 条/秒）本来够用，所以这次迁移解决的是**卡顿风险与扩展性**，不是吞吐。

**代码改动**：

- store 的 11 个方法全部改 async；14 个调用点加 `await`（其中 `ws.ts` 的两处强制了"先落库、再广播"的顺序）；
- SQL 方言：`MAX(a,b)` → `GREATEST`、`BEGIN IMMEDIATE` 的写锁语义 → `UPDATE conversations SET last_seq = last_seq + 1 RETURNING last_seq`
  的**行锁**（并发写同一会话由行锁串行化，实测 20 条并发得到 1..23 连续无洞）；3 处 pragma 删除；
- **顺手修掉 N+1**：会话列表原本"逐个查最后一条消息"，现在用 `LEFT JOIN LATERAL` 一次取回；
- `pg` 默认把 `int8` 解析成字符串，统一在池初始化处转 number（毫秒时间戳远小于 2^53）；
- **测试从内存 SQLite 改为真实 PostgreSQL**：每个用例一个独立 schema（毫秒级创建/销毁、天然隔离可并行），
  断言仍打真库——内存模拟会掩盖 `ON CONFLICT`、部分唯一索引、行锁这些真正要验的行为；
- 依赖：msgbus 去掉 better-sqlite3、加 `pg`；`tsconfig` 增加 `exclude`（**测试与 src/testing 不进产物**）。

**部署**：生产在已有 postgres 实例里新建 `msgbus` 角色与 database（不动 new-api 的库）；
compose 里 msgbus 加 `DATABASE_URL`、挂 `internal` 网络、去掉 `msgbus-data` 卷；原有数据
（1 会话 / 2 成员 / 1 消息，含那条被撤回的痕迹）已导入 PG。

**两个上线坑**：

1. **排除上传目录会留下旧副本**：上一版把 `src/testing` 留在生产，新代码不再需要它，但 `tsc` 仍会编译它 →
   构建失败（3 个类型错）。修法不只是删文件，而是让 `tsconfig.json` 直接排除测试与脚手架
   ——产物里永不含测试代码，这类"本地删了、生产还在"的失败不会再发生。
2. **compose 去掉卷 + 构建失败 → 旧镜像起不来**：`up -d` 在构建失败后回退到上一版镜像，而旧镜像写
   `/data/msgbus.db`、卷已被移除 → 崩溃重启循环（IM 短暂不可用）。教训：**改容器挂载与镜像内容是同一批操作时，
   先确认构建成功再 `up -d`**。

**验证记录（本轮实际执行）**：

- 本地：msgbus **55 条用例全绿**（新增两条并发用例：20 条并发发送 seq 必须是连续 1..20；并发重发同一
  `client_msg_id` 只落一行），`tsc --noEmit` 干净。
- 生产（临时 schema，不动真实会话）：顺序写入 seq `[1,2,3]` → 再并发 20 条后全部 seq 为 **1..23 连续无洞**；
  幂等重发返 `duplicated`；撤回后**库里留原文 `"x"`、对外下发 `""`**；
- 生产端到端：`/api/conversations` 经 23090 返回导入的那条 DM（含已撤回消息）；**WS 经 nginx 握手拿到 `ready`**；
  网关回归 `handoff/start=201`、`health=200`；8 个容器、msgbus healthy。
- 回滚材料：旧 SQLite 卷 `ucas-proxy-prod_msgbus-data` 保留未删；源码备份在
  `/home/services/ucas-proxy/backups/im-pg-*`。**注意**：镜像是同 tag 覆盖的，回滚需要回退源码后重新构建。

### 下一步（按依赖顺序）

1. 桌面真机联调：起本地 msgbus（可配存根 control-plane，或与真网关同机）→ 打开侧栏「消息」→ 单聊/群聊往返、断线重连补洞、未读角标。
2. UI 的 e2e：按仓库约定补 `packages/ui/test/*.e2e.mjs`（需要 browser-harness 授权）。
3. 两层 nginx 接线与上线（`Upgrade` + `proxy_read_timeout`），属部署范围。

## 十、频道模型调研与目标架构（2026-10-17）

问题：现有模型（`conversations(kind=dm|group|channel)` + `members` + `messages` 三张表）离 Discord 的
频道体系差多远？要不要换一个更成熟的开源架构？

### 10.1 现状缺口（对照我们的真实 schema）

| 维度           | Discord                                                                          | 我们                        | 判定                                                   |
| -------------- | -------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| 容器层级       | Guild → Category → Channel → Thread                                              | `conversations` 平铺        | **缺**：没有"空间/团队"层，channel 与 group 是平级兄弟 |
| 分组           | Category（≤50 个频道，不参与权限继承）                                           | 无                          | **缺**：没有侧栏分组                                   |
| 频道类型       | text/announcement/forum/media/voice + 线程三种                                   | `kind='channel'` 语义未定义 | **缺**：类型没有行为差异                               |
| 话题           | 线程：public 必须从消息长出，private 可独立                                      | 无                          | **缺**：讨论无法收束，全员挤一条流                     |
| 权限           | role + 频道级 allow/deny 覆盖（8 步决议，**specificity 胜出**而非"deny 永远赢"） | owner/member + 应用级白名单 | **缺**：没有频道级 ACL，做不到"部门可见"               |
| 消息           | 回复引用、reactions、@、置顶、附件、编辑                                         | 纯文本 + 撤回（留痕）       | 缺绝大多数                                             |
| 未读           | Discord **没有**公开的已读 API（客户端自管）                                     | `last_read_seq`（够用）     | 我们更完整，但缺"公开/私密已读"的区分                  |
| 搜索/管理/留存 | 有，但企业要的合规/留存 Discord 都没有                                           | 无                          | 缺；但 Discord 也不是参考对象                          |

结论：**"太简单"是事实**，缺的是"空间 → 频道 → 话题"三层结构 + 频道级权限 + 话题化讨论。

### 10.2 成熟开源方案调研（均为 2026-10-17 实查，含许可与活跃度）

**整包采用**（我们只写 UI，做它 API 的客户端）：

| 项目                                         | 提供什么                                                                                                                                                                           | **致命阻塞**                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zulip**（Apache-2.0，26.0k★，昨日推送）    | **唯一原生支持外部 JWT**（`JWT_AUTH_KEYS` + `/api/v1/jwt/fetch_api_key`，payload 只认 email）；话题模型最正统（"话题是标签，不是消息"）；频道文件夹、每频道权限、无 open-core 目录 | 运维是 Django+Tornado+PG+Redis+RabbitMQ+memcached 的**整套 appliance**；实时是长轮询；**"超过 10 人的组织"要用它的手机推送要付费**；话题优先的 UX 对 205 个用惯企微的人是强加 |
| **Mattermost**（MIT 二进制/AGPL 源，39.4k★） | 频道+线程+每用户未读计数最完整；REST v4 有 549 个接口；管理员可给任意用户签发 token                                                                                                | **SSO 已从 Team Edition 移除（OIDC/SAML/LDAP 全付费）**；WebSocket 事件 API 官方文档已下线（反向工程）；合规/留存/HA/企业搜索全付费                                           |
| **OpenIM**（Apache-2.0，16.7k★）             | 身份最贴合（"业务后端是唯一事实源"，userID 由调用方给，后端签发 IM token）；有官方 Electron SDK                                                                                    | **完全没有频道/话题**（群 + 会话只有客户端分组）→ 直接不满足需求；7 个核心容器（mongo/redis/kafka/etcd/minio/…）；JS SDK 与 Web/管理台是 ARR 闭源                             |
| **Matrix/Synapse**（AGPL-3.0）               | 唯一**标准协议**；Spaces/Rooms/Threads 都稳定；Application Service 可"以成员身份说话"（agent 的理想模型）；power levels 是最完整的每房间覆盖                                       | 你得**写一个 Matrix 客户端**（`/sync` + E2EE + 设备验证）；单租户下联邦/E2EE 是纯负担；无原生外部 JWT（要 appservice 或密码 provider 模块）                                   |
| **Rocket.Chat**（MIT + ee/，46.3k★）         | 模型最贴需求（channels/teams/discussions/threads + 房间级角色）；官方 compose 只要 2 个容器                                                                                        | 现代 REST 类型里**没有 JWT 登录**；DDP（Meteor）协议要自己实现；guest 与自定义角色是企业版                                                                                    |
| **Tinode**（GPL-3.0，13.5k★）                | 最轻量最 API-first（纯 Go，WS JSON，无强制 Web UI）；位图访问模式 + 每用户覆盖设计干净                                                                                             | **没有频道/分组/话题/角色/组织**：`head.thread` 明确只是"给扁平消息打标签"；GPL-3.0 对"交付设备"有传染性                                                                      |

**抄模型**（我们继续自己写服务端，但按成熟模型设计）：

- **Mattermost 的骨架**最贴需求：`Team → Channel → (Thread)`，线程是"可关注、有未读计数的实体"
  （`get-user-threads`/`start-following-thread`/`update-threads-read-for-user`），未读是成员行上的**计数器**
  （`msg_count` / `msg_count_root` / `mention_count` / `urgent_mention_count`），权限用 **scheme + 频道覆盖**。
- **Matrix 的权限**：数字 power level 同时管"某用户"和"某类事件"，是"每频道覆盖"最好的答案（抄想法，别抄 AGPL 代码）。
- **Zulip 的话题**：话题是消息上的**字符串标签**，不是容器——"第一条消息没有特殊性"这条洞见让
  改名/移动话题变成一次批量更新，而不是 schema 操作，也没有孤儿话题要清理。
- **Tailchat 的权限点用字符串**（`core.message` 这种命名空间）而非位域：插件/扩展能自己加权限点，
  位域会冻结权限词表。

### 10.3 目标模型（建议）

在现有 3 张表上演进，不推倒重来：

```
space(id, org_id, name, visibility)                        -- 取代现在平铺的 channel/group 容器
section(id, space_id, name, position)                      -- 只做侧栏分组，零 ACL 语义
channel(id, space_id, section_id?, name, topic, kind: text|announcement|forum,
        access: public|space_private|invite_only, retention_days?, permission_scheme_id?)
channel_override(channel_id, subject_kind: role|user, subject_id, allow: text[], deny: text[])
role(id, space_id, name, rank, permissions: text[])        -- 命名权限点，不是位域
message(... 现有字段 + thread_topic TEXT? + reply_to_id?)   -- 话题=标签（Zulip 式），回复=指针
thread_follow(principal_id, topic_or_root_id, subscribed, last_read_message_id)
read_state(principal_id, scope: channel|topic, scope_id,
           fully_read_id, last_read_public_id, last_read_private_id,
           unread_count, unread_root_count, mention_count, urgent_mention_count)
```

### 10.4 三条必须避开的坑（都有实证）

1. **别把"线程"做成容器**。Spacebar 开发六年仍未实现 message threads；Discord 用一套 channel 类型枚举
   - 独立 `ThreadMember` 表表达线程 = 等于第二套频道系统。Zulip/Slack/Matrix 都收敛到"消息上的扁平关系
   - 每用户关注/已读状态"。
2. **别抄位域权限 + rank 阶梯**。Stoat 需要写注释限制"只用低 52 位以适配 JS"；位域还冻结权限词表。
   用命名权限点 + 行级 allow/deny 覆盖（同一套词表，用户覆盖胜过角色，deny 在**同一层**内先于 allow）。
3. **别把已读状态混成一个数**。Matrix 有三个：`m.read`（同事可见）、`m.read.private`（只用于清通知）、
   `m.fully_read`（UI 回到哪里）。合成一个数要么泄露"谁读过"（企业里的隐私问题），要么通知清不掉。
   另外**"分类"不是权限边界**：Matrix 的 `restricted` 加入规则只在 join 时校验一次，被移出空间的人
   仍保有已加入房间的访问权——空间授予的可见性必须**展开成成员行并每次请求重新校验**。

### 10.5 分期（在现有实现上叠加）

- **P1 空间与频道**：`space` + `section` + `channel.access`；把现有 `kind='channel'` 的会话迁移成
  `space` 下的频道；频道级 `permission_scheme` 先只做 `public | space_private | invite_only` 三档。
- **P2 话题与未读**：消息加 `topic`（Zulip 式标签）+ `reply_to_id`；未读从"一个 `last_read_seq`"升级为
  频道 + 话题两级计数（含 `mention_count`）。
- **P3 富消息**：附件（对象存储）、@提及（写入时就解析成 mention 行，读取不再重解析）、reactions、置顶、搜索。
- **P4 管理与治理**：频道归档、留存策略（`retention_days`）、审计事件表、离职自动退群。
- **P5（可选）agent 作为成员**：`principal.kind = 'user' | 'agent'`——这正是 Matrix Application Service 的
  简化版，也是我们"agent 进频道"差异化能力的落点。

### 10.6 但"替代企微"这件事，调研给的结论是：手机决定一切

- **中国没有统一推送**：自建 App 要接入小米/华为/OPPO/vivo/魅族/荣耀 + APNs 各自的 SDK 与开发者账号；
  OpenIM 官方只推荐个推（GeTui），野火开源了 `push_server` 覆盖全部厂商——这本身就是"这块很难"的证据。
- **iOS 内部分发是制度成本**：Apple Developer Enterprise Program 299 USD/年，要求"100 名以上员工"、
  D-U-N-S、合规主体、验证面试，且每年复核。企微已经解决了分发，且人人已装。
- **企微的会话存档不是免费的**：它是**需要下单购买、会过期**的权益（错误码 `301052` 服务已过期 /
  `701139` 无法创建订单），需要客户端 ≥2.8.9 + 每个员工的告知页面 + 可信 IP + 自备 RSA 公钥，
  **只能看到至少一方开启了存档的会话**，且**只能拉 5 天内**的消息（必须常驻拉取）。
- **最省力的接入点是"智能机器人长连接"**：无需公网 IP、无需加解密、30 秒心跳、群内 @ 触发、
  `stream.id` 流式输出——与我们已有的 WS 传输、流式回复、bots provider 结构几乎一一对应。

结论：**公司级通信继续以企微为载体（身份 + 通讯录 + 手机可达），我们自己的频道体系做"团队内部 + 产品面"**，
不走"自建 IM 替代企微"的路。这条判断与 §10.2 的取舍独立——即使整包采用某个开源 IM，手机可达性这关一样要过。

## 十一、移动端：iOS / Android / 鸿蒙（2026-10-17 调研）

前提（负责人口径）："到时候可能也会发布 UWork，只要能够适配 iOS、安卓、鸿蒙。"——即要**自建移动端 App**，
不只是手机网页。这一条直接决定了推送与分发必须先解决。

### 11.1 我们已经有什么（仓库实测）

`packages/android` 已经是一个 **Kotlin + Jetpack Compose 应用**（约 1,238 行）：Compose 里用 `AndroidView`
托管 WebView（加载 `packages/web` 的页面）、**前台保活服务** `RemoteControlKeepAliveService`
（注释写明"前台服务不能保证 WebView socket 永不断……真正的状态恢复交给 web 端可重复快照协议"）、
扫码、深链（`zcode://remote` 与 `https://zcode.z.ai/remote`）、通知权限——**但没有任何推送 SDK、没有登录、没有聊天页**。

也就是说：**架构方向已经对了（一套 Web UI + 薄原生壳）**，Android 壳要补的是推送、身份与分发，
iOS 与鸿蒙是从零写壳（但同样只是壳）。保活服务本身是为"没有推送"打的补丁——有了推送，模型反过来：
**推送唤醒 → App 重连 → 用 `since` 补洞**（我们的协议已经支持）。

### 11.2 三个平台的硬事实（均为官方文档实查）

|            | iOS                                                                                                                                                                                                                                                   | Android                                                                                                                                                                                            | 鸿蒙 NEXT                                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 复用现有壳 | 否（要新写壳）                                                                                                                                                                                                                                        | **可以**（现有壳基础上加推送/登录）                                                                                                                                                                | **完全不能**：NEXT（= HarmonyOS 5）**不跑 APK**，要新写 ArkTS 应用                                                                                                                     |
| 内部分发   | **App Store 走不通**：WebView 套壳撞 4.2，远控类撞 **4.2.7（要求主机与客户端在同一局域网、且"云应用瘦客户端不适合上架"）**；→ **Enterprise Program：299 USD/年**，要求**报名主体自身 ≥100 名员工**（明确不接受分支机构）、D-U-N-S、验证面试、每年复核 | 直接发 APK 在国内企业内部很常见（自建更新或 MDM）；但**不上架会影响推送权限**（见右）                                                                                                              | **In-house/指定设备发布**：每个 Profile 100 台设备、最多 100 个 Profile（205 人足够），**支持手机**；企业开发者账号需营业执照 + 对公账户                                               |
| 推送       | APNs，一个团队 key 打所有 App，无日配额                                                                                                                                                                                                               | **厂商碎、且与上架绑定**：小米"必须完成上架后才能启用推送"；OPPO 自 2024-07-29 起**非商店安装失去公信**；vivo 自 2025-02-17 起**非商店安装默认关闭运营消息**；华为/荣耀/魅族另有各自账号与分类审核 | Push Kit **免费**；但**未申请"自分类权益"时每天每设备只有 2 条**；IM 属"服务与通讯类"不受条数限制（华为原文举例就是"企业内部办公应用，同事间的点对点聊天消息"），需申请，约 3 个工作日 |
| 后台       | 静默推送不保证送达（"每小时别超过两三條"、被强杀即丢弃）→ 聊天必须发**可见通知**                                                                                                                                                                      | 进程被杀后只有厂商通道能到；各 OEM 要用户手动加白名单（自启动/后台保护）                                                                                                                           | **WebView 后台什么都拿不到**（文档明确挂起后不能用网络与定时器）→ 实时只能靠原生推送                                                                                                   |
| 特别约束   | Enterprise 报名主体必须是**有 ≥100 员工的法人实体**（三家子公司要注意报哪个主体）                                                                                                                                                                     | 各厂商还要申请渠道/模板/自分类权益（属"账号文书"而非代码）                                                                                                                                         | **不能自带 WebView 内核**，只能用系统的 Chromium，且随系统版本从 **M99 / M114 / M132 / M144** 不等 → 我们的 web 包必须至少在 M114 与 M144 上测过                                       |

**最容易漏的一条合规**：**工信部 APP 备案对所有 App 都强制**（即使不上任何商店）——需提供包名/Bundle ID、
公钥、Android 的 MD5 或 iOS 的 SHA-1、SDK 厂商清单，约 20 个工作日审核，且**备案号要在 App 内展示**；
未备案会被接入商拦截域名。

### 11.3 建议顺序（先让"消息能到人"，再让壳变真）

1. **P0 通知先用企微应用消息**（与 §10.6 同一条）：零成本、几天可上；我们已有身份集成与 agentId。
   配额对 205 人很宽（每应用 200 人次/天 × 账号上限；单成员 30 次/分钟、1000 次/小时）。
   代价：无角标控制、点通知不能深链、通知落在企微的托盘里。
2. **P1 移动网页先当"移动端 v1"**：现有 `/remote/v4` 页 + 聊天面板，零分发零审核，iOS/Android 都能用。
3. **P2 iOS 壳（走 Enterprise，不走 App Store）**：iOS 只有一个推送通道（APNs），没有厂商泥潭；
   **报名周期是最长的一环，现在就该启动**——先确认三家子公司里哪个主体自身 ≥100 名员工。
4. **P3 Android 壳**：用聚合器（极光/个推）而不是逐个接 7 家 SDK；但要接受"非商店安装的通知降级"这个上限，
   真要"像微信一样可靠"就得上架小米/OPPO/vivo 商店拿正式权限。
5. **P4 鸿蒙 NEXT**：**代码量很小**（ArkTS 壳 + ArkWeb 组件 + Push Kit 处理，几百行），
   期间 4–8 周主要是账号/资质/审核。**先做一件事**：向 `agconnect@huawei.com` 书面确认
   "**In-house（指定设备发布）的应用能否使用 Push Kit**"——这是整个方案成立与否的唯一未验证点。

### 11.4 服务端无论走哪条路都要补的（推送基础设施）

- `device_token(user_id, platform, vendor, token, app_version, push_enabled, muted_until, last_seen_at)`，
  唯一键 `(vendor, token)`；收到 `410 Unregistered`／厂商回执失效／登出时删除。
- `push_job(...)` **与消息写入同一事务**——这样"通知描述的是一条不存在的消息"在结构上不可能发生。
- 推送决策顺序：在线且有前台会话 → 不推；免打扰/静音 → 不推但未读照涨；否则**每会话一条 + 折叠键**
  （`apns-collapse-id` ≤64 字节，Android 各家对应）。
- **角标必须是"该用户总未读"的绝对值**，不是 `+1`——JPush 服务端 SDK 默认 `+1`、MIUI 默认"收通知 +1 / 打开清零"，
  这正是"角标只显示新消息数"的成因。未读以服务端为准（我们的 `last_seq - last_read_seq`），
  手机上任何一端已读都要让其它端的角标一起降下来。

**这一步的实质**：移动端不是"适配三个平台"，而是"**推送体系 + 三套壳 + 三套分发资质**"，
其中代码量最小、流程最长。真正的先手是把 P0（企微通知）做掉，让聊天先可用，再去啃壳与资质。

### 11.5 分发决策：内部分发、不上架（2026-10-17 定）

负责人口径："不需要上架，把 APK 做好分发给大家直接安装，之后上架再说。" 这条在安卓与鸿蒙上成立，
但在 iOS 上不成立；而且**"不上架"对推送的杀伤已经查实到厂商级**（见下表），
所以通知策略必须相应调整。

**厂商级推送权限（不上架时）——这是本节最重要的一张表**：

| 厂商               | 不上架能否启用推送                 | 不上架能发什么                                                                                               | 依据                                                                                                                                                                                      |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **vivo**           | **不能**                           | 仅"受限/测试权限"：1000 条/天测试消息，**不能给线上用户推送**                                                | 厂商原文："应用必须上架才具备线上推送能力，上架后才可以给线上用户推送……推送权限为【正式】"                                                                                                |
| **OPPO**           | **不能**                           | 仅测试权限（1000 条/天），且**"通讯与服务"类不支持**——即聊天通知这类根本发不了；正式权限"资源上架后方可申请" | 厂商文档 + 聚合器文档                                                                                                                                                                     |
| **小米**           | **高风险（未证实）**               | 若可启用：默认通道仅 **1 条/设备/天**，私信类需平台申请+模板                                                 | ⚠️ 我此前引用的"必须完成上架后才能启用推送"**在小米官方文档中查不到**（已证伪）；但极光 JPush 的对照表把小米标为"需要上架"。**待实测**：拿真包名 + release 证书指纹到小米推送控制台试启停 |
| 华为 / 荣耀 / 魅族 | 可以（聚合器口径，厂商文档未直读） | 服务与通讯类不限量；但**未申请"自分类权益"时会被智能分类**，可能落进每天 2 条的营销桶                        | 极光 JPush《厂商通道参数申请指南》                                                                                                                                                        |

补充事实：推送投递按**包名 + 签名证书指纹**判定，与安装来源无关——所以**必须用 release 证书在各厂商平台登记**
（debug 包拿不到厂商推送）；但 vivo/OPPO 即便登记了 release 证书，未上架仍只有测试权限。

**结论（不上架的现实）**：安卓上真正能覆盖的只有**华为/荣耀/魅族**；**OPPO/vivo 等于没有 App 推送**，
小米待实测。这直接改变产品形态判断：**对 OPPO/vivo 用户，"手机网页 + 企微通知"与我们的 App 几乎等价**
（App 的增量本来就在于推送/角标/后台，而这几样恰好拿不到）。所以这两个厂商的用户在"之后上架之前"
不必强推 App。

**企微应用消息只能点进网页，不能唤起我们的 App（已查实）**：所有 msgtype 的 `url` 只接受 http/https，
没有 scheme 字段；企业微信文档树里**没有开放标签**（`wx-open-launch-app` 是微信/公众号的能力，需要认证服务号 +
微信开放平台绑定移动应用 + App 接入微信 OpenSDK）。因此通知里的落地链接应指向**移动网页**，
不要指望它能打开 App——这与"移动端 v1 = 网页"的建议天然一致。

其余落地要点：

- **Android 自更新**（同签名 key + `REQUEST_INSTALL_PACKAGES`，或 MDM）：否则用户永远停在旧版本，
  服务端必须能**强制最低客户端版本**。
- **安装引导**：各 OEM 默认杀后台，需引导用户加白名单（小米自启动/神隐、华为自启动+后台保护、
  OPPO 纯净后台+自启动+锁定、vivo i管家自启动+内存白名单、魅族自启动+待机耗电）——这是给 205 人发的说明，
  不是代码问题。
- **iOS：不上架 ≠ 不需要企业资质**。iOS 没有"允许未知来源"，205 台 iPhone 装 App **只有 Enterprise 一条路**
  （299 USD/年 + 报名主体自身 ≥100 员工）。所以"之后上架再说"在 iOS 上等于"iOS 先不做"。
- **鸿蒙：In-house/指定设备发布本身就是"不上架"路径**，且正好绕开公开市场对套壳的第 3.5 条拒绝；
  但仍需企业开发者账号（营业执照 + 对公账户），且"非上架 App 能否用 Push Kit"仍待华为书面确认。
- **工信部 APP 备案照做**（约 20 工作日，备案号要在 App 内展示），不上架也不例外。

**对通知策略的最终结论**：**企微应用消息是跨厂商的基线通道**（免费、2048 字节 text/textcard、
每应用 200 人次/天 × 账号上限、单成员 30 次/分与 1000 次/时；落地只能到网页），
**App 存活时的长连接**做应用内投递，**厂商原生推送只作为华为/荣耀/魅族的增强**。

## 十二、UI 层调研：成熟聊天界面能不能直接接进来（2026-10-17）

问题（负责人口径）："重要的是 UI 能不能直接接进来，也就是成熟的 UI 界面设置。"——即不想手搓界面，
希望拿一个成熟的聊天 UI 改一改就用。以下均为实查（许可证逐文件核对、LOC 实测）。

### 12.1 直接回答：**没有可以直接插进来的成熟聊天界面**

| 候选                              | 实际性质                                                 | 为什么不能直接用                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stream Chat React**             | **不是开源**                                             | LICENSE 是"SOURCE CODE LICENSE AGREEMENT…PROPRIETARY PRODUCT"，要求使用者是 Stream 的**付费客户**且非竞品；UI 绑死 `stream-chat` SDK 与云端           |
| **CometChat UIKit**               | **不是开源**                                             | 许可证只写了 ToS 链接；`CometChat.init(appId)` 绑死其云（私有化是 Enterprise 附加项）                                                                 |
| **Sendbird UIKit**                | MIT，但**焊死自家 SDK**                                  | 真 MIT 可 fork，但 `@sendbird/chat` 是直接依赖，没有可注入的"chat client"接口；数据层换不动                                                           |
| **腾讯 ChatUIKit React**          | MIT，但**焊死腾讯云 SDK**                                | 界面最贴中文 IM（会话列表/消息列表/输入框/群管理齐全），但没有自托管方案                                                                              |
| **Element Web**                   | AGPL/GPL/商业三选一 + **53% 文件 import matrix-js-sdk**  | 内部分发也会触发 GPL 的源码义务；且 1306/2482 个文件写死在 Matrix 数据层上                                                                            |
| **Mattermost webapp**             | `webapp/` 确为 **Apache-2.0**（已核对 LICENSE.txt 原文） | 但 85 万行；真正拖住你的是 `mattermost-redux` 的 **326 文件 / 8.8 万行领域逻辑**（teams/channels/posts/Apps/策略），不是"换掉一个 API client"能解决的 |
| **Rocket.Chat 客户端**            | MIT（`ee/` 除外）                                        | 是 **Meteor 应用**：451 个文件调 384 个端点、认证是 Meteor Accounts；界面部分（MessageList/Message 组件）**未发布**                                   |
| **chatscope/chat-ui-kit-react**   | MIT，唯一有完整 IM 骨架                                  | 样式停在 2022（预编译 CSS + FontAwesome）、无虚拟化；只适合当**需求清单**                                                                             |
| **Revolt / Wire / OpenIM 客户端** | AGPL/GPL                                                 | 许可证直接出局（OpenIM 的 React/Electron 客户端是 AGPL-3.0）                                                                                          |

**唯一"整包拿过来改"算术成立的是 Tailchat**（Apache-2.0，客户端 3.0 万行 + shared 8 千行）：
React+TS+**Tailwind**+zustand、Discord 式"群→面板"结构、代码里明确支持前后端分离
（`client/web/build/webpack.config.ts` 的 `SERVICE_URL`）、**传输层只有 3 个文件 451 行**
（`client/shared/api/{request,socket}.ts`，改这里 + 73 个端点调用点即可指向我们的后端）。
代价：客户端停在 **React 18 / Tailwind 2 / antd 4 / axios 0.21**（上游只维护服务端与 admin-next），
缺**输入中提示、线程、通知层、通用文件发送**，且 fork 后没有上游更新路径。
**许可证前置条件**：`client/shared/package.json` 写的是 `"license": "GPLv3"`（与根 Apache-2.0 矛盾），
fork 前要拿到作者的书面更正。

### 12.2 我们仓库里已经有"最难做对的那一层"

成熟感的来源不是"有没有库"，而是三件事：**会话列表的信息密度**、**消息列表的滚动行为**、
**消息的可操作性**（表情/线程/附件）。而其中"最容易做丑"的消息渲染与输入区，
**我们仓库里已经有一整套成熟件**（Vercel AI Elements，Apache-2.0，已 vendor）：

- `packages/ui/src/components/ai-elements/conversation.tsx` — `Conversation` / `ConversationContent` /
  `ConversationScrollButton`，底层是 `StickToBottom`（贴底、用户上翻即停、回到底部按钮）。
- `message.tsx` — `Message` / `MessageContent` / `MessageActions` / `MessageAction`（消息行与操作区）。
- `prompt-input*.tsx`（含 attachments 上下文）与 `LexicalChatInput.tsx`（1,538 行，带 @提及、粘贴、草稿、提交语义）。
- `chat-loading.tsx` / `shimmer.tsx` / `attachments.tsx` / `image-preview-dialog.tsx` / `code-block.tsx` 等。

`components.json` 里还注册着 AI Elements registry（`@ai-elements` → ai-sdk.dev），可直接 `shadcn add` 补件。
**结论：第 11.4 节那种裸 `<div>` 气泡 + 裸 `<textarea>` + 手写 `scrollTop=scrollHeight` 的写法是错的**——
不是因为缺库，而是因为没用手边已装好的成熟件。

### 12.3 目标写法（"接成熟件"的具体清单）

1. **消息时间线**：改用 `Conversation`(StickToBottom) + `Message`/`MessageContent`，行为与 agent 对话一致（同一套滚动语义）。
2. **列表引擎**：`react-virtuoso`（MIT，唯一有原生聊天语义：`followOutput` 贴底、`firstItemIndex`+`startReached`
   前插历史不跳位、`initialTopMostItemIndex` 直达未读、`atBottomStateChange` 跳到底部）。
3. **输入区**：`PromptInput` 家族（附件、快捷键、提交语义），需要 @提及则接 `LexicalChatInput`。
4. **会话行字段清单**：照 chatscope 的 `unreadCnt` / `unreadDot` / `lastSenderName` / `lastActivityTime` / `active`
   把"成熟会话行"该有的信息补全（头像、预览、时间、未读、静音/置顶）。
5. **缺什么去 Mattermost 抄零件**（Apache-2.0，样式需移植到 Tailwind）：虚拟化消息视图、线程视图、
   文件预览（含 pdfjs）、emoji picker、快捷键系统、@提及。
6. **表情/回复/线程/附件**：`emoji-mart` 或 `frimousse`（均 MIT）+ 上面的抽象。

### 12.4 两条路线，供拍板

- **路线 A（推荐，周级）**：继续自持界面，但**改成搭成熟组件**——AI Elements（已在仓）+ react-virtuoso +
  Mattermost 零件 + chatscope 字段清单。保留我们的身份、组织隔离与 agent 能力，改动集中在 UI 层。
- **路线 B（整包 fork，月级 + 长期维护）**：fork Tailchat 客户端，repoint 到 msgbus（451 行传输层 + 73 个端点），
  改登录为我们的 JWT/企微。先做一个 spike 验证 repoint 与登录要多久；代价是接手一个旧栈客户端并自行维护，
  且没有上游更新路径。

### 12.5 已落地：按成熟 IM 的组织方式重排界面（2026-10-17 / 10-18）

不再手搓，改成"沿用成熟客户端的界面组织 + 用仓库里已有的成熟件"。

**定稿的形态（2026-10-18 用户拍板）：C 的骨架 + B 的消息列 + 微信式的会话行。**

- **骨架（三栏 + 可收起右栏）**：会话列表（`w-52`）｜消息列（`flex-1`）｜右栏（`w-60`，群设置；
  线程、成员名片之后放这里）。消息列表头右侧一个 `PanelRightIcon` 开关，单聊不显示（没有可设置的）。
  三个都塞不下时——该侧边面板最窄可以被拖到 240px——按容器宽度退化，不看窗口宽度：
  实测宽度 < 700px 时右栏改成**浮层**盖在消息列上（`absolute right-0 z-20 shadow-xl`），
  < 460px 时列表与消息列**二选一**（列表 `hidden`，消息列头部给返回键）。
  宽度用 `ResizeObserver` 量面板根节点，阈值写在 `MessagesSidePane.tsx`。
- **消息列不用气泡**（B 的形态）：36px 头像 + 「姓名 + 时刻」+ 正文，自己的消息写作「某某（你）」并
  **保持左对齐**。理由不只是"跟主流"（Slack / Teams / Discord / Zulip 都收敛到这个形态，气泡只留在消费级
  IM）：气泡会砍掉近一半可用宽度，而 agent 的产出、代码、日志在气泡里很难看。
  表头时刻只给 **HH:MM**，日期交给分隔线——两处都写"昨天"是重复。
- **会话行用微信式**：40px 头像（单聊圆形/群方形）+ 名称 + 预览（自己的消息加「你：」）+ 右上角时间 +
  未读徽标，顶部搜索框，空态/无结果态，选中与悬停有反馈。
- **纯逻辑层** `packages/ui/src/im/imPresentation.ts`（15 条单测）：头像取色（同一 id 固定色）、
  姓名缩写（中文取后两字/英文取首字母）、**时间文案统一在规则层成句**（会话行时间、消息时刻、日期分隔；
  早先返回 `weekday:3`/`yesterday` 这类 token 让调用方各自映射，结果消息头把 token 原样渲染了出来）、
  会话标题/副标题、预览文案、**时间线组织**（跨天插日期分隔、未读位置插「以下是新消息」、
  同一人 5 分钟内合并头像与姓名）。
- **滚动**用仓库里已有的 StickToBottom（`Conversation`/`ConversationContent`/`ConversationScrollButton`），
  不手写 `scrollTop = scrollHeight`。撤回悬浮两步确认，草稿按会话存 localStorage（`uwork:im-draft:<id>`）。

**顺手修掉的真机 bug（10-18）**：没打开项目时点侧栏「消息」入口什么都不出现。
`openMessagesSidePane` 用 `workspaceIdentity || workspacePath` 当 `workspaceKey`，两者都空时 tab 的
`workspaceKey` 是空串，而可见性判断是 `tab.workspaceKey == null || tab.workspaceKey === activeWorkspaceKey`——
空串既不等于 `null` 也不等于当前 key，tab 被过滤掉了。修法是把空串归一成"没有 workspace"
（`normalizeSidePaneWorkspaceKey`，`packages/ui/src/lib/workspaceSidePane.ts`），并补两条回归用例。
教训：**"全局 tab" 的判据必须是 `null`，不能在调用方用空串凑**。

**仍未做（要"完全成熟"还差的）**：回复引用、表情回应、附件与图片预览、正在输入提示、
系统消息（"X 加入了群聊"）、消息内跳转的快捷键（现在只有查找条）。这些在 §12.3 的清单里，按顺序补。

### 12.7 成熟度补齐：发送状态 / 会话内搜索 / 置顶静音 / 群成员数（2026-10-18）

四个都只动客户端，不动协议与表结构。

- **发送中/失败（乐观发送）** `imOutbox.ts` + `useIm.ts` + `ImTimeline.tsx`：
  点发送先落一条本地消息（立刻可见），状态由发送结果决定；失败不删不改正文，行上给「重试/删除」。
  **重试必须复用同一条的 `clientMsgId`**——否则"请求到了服务端、只是回包丢了"会变成两条消息。
  为此 `IImService.sendMessage` 接受调用方传入的 `clientMsgId`（不传仍由服务内部生成，行为不变）。
  认领回包按 `clientMsgId` 匹配，**不看正文**（正文可能被服务端规整）。
- **会话内搜索** `imSearch.ts` + `ImConversationSearchBar.tsx`：只搜**已加载**的消息，条上写明范围
  （"仅搜已加载的 N 条"）——把"没搜到"和"没加载"混在一起就是骗人。命中处套 `<mark>`，
  当前命中整行高亮并 `scrollIntoView({block:"center"})`；Enter/Shift+Enter 上下条，Esc 关闭，切会话自动收起。
- **置顶/静音** `imPreferences.ts` + `ImConversationList.tsx` + `useImSidebar.ts`：
  **纯客户端偏好，不入库**（不是团队事实、也不是权限，服务端多一张表只会多一份要治理的数据）。
  置顶优先排序；静音不进侧栏总角标、未读从数字降级成圆点——静音的语义是"别打扰我"，不是"我看不到了"。
  用一个小 store（`useSyncExternalStore`）而不是层层传参，因为列表与侧栏角标在两棵子树里。
  存储不可用时（隐私模式/实现不完整）降级到内存，不让面板打不开。
- **群表头成员数**：会话摘要里没有成员数，按会话调一次 `listMembers` 计数，切走时取消，
  避免旧会话的响应盖到新会话表头上。

**顺手修掉的一类真 bug（不是 IM 的，已连根拔掉）**：状态只在 `requestAnimationFrame` 里提交。
**窗口被遮挡/最小化时 Chromium 暂停渲染，rAF 回调不是延迟、而是被丢弃**——那次提交就永久丢了，
恢复窗口也回不来（触发它的事件已经过去）。受害面比想象大：右侧面板永久不可见（终端、预览、IM）、
粘性分组表头永久 `opacity-0`、toast 永久停在未进入态（到点又被自动移除，用户什么都没看到）、
Rive 角色头像永不初始化。修法是收口到一个调度器 **`packages/ui/src/lib/nextFrame.ts`（`runOnNextFrame`）**：
页面不可见时**同步执行**（异步兜底会被隐藏页面的定时器节流拖到分钟级）；页面可见时走 rAF
**另加 250ms 兜底定时器**，谁先到谁执行——覆盖"排上队之后窗口才被遮挡"这种竞态；返回取消函数。
四个站点（`useAnimatedResizablePanel`、`StickyGroupHeaderSlot`、`components/ui/toast`、
`components/ai-elements/persona`）已改用它。**判据**：只要"某个状态只有 rAF 一条提交路径"，就是这一类。
（其余几十处 rAF 是聚焦/测量/滚动这类自愈动作，不改——隐藏窗口里丢一次没有永久代价。）

**验证**：新增 11 条纯逻辑用例（出站队列/搜索/偏好，`test/imComposerState.test.ts`）、
5 条 jsdom 组件用例（置顶排序与置顶标记、静音圆点 vs 数字、命中 `<mark>` 与整行高亮、乐观消息两种状态与重试/删除，
`test/imPaneFeatures.test.ts`）、5 条调度器用例（`test/nextFrame.test.ts`）、3 条面板可见性用例
（隐藏窗口里打开必须可见 / rAF 被丢弃时兜底定时器兜住 / 关闭不依赖帧，`test/animatedPanelVisibility.test.ts`）、
1 条服务层 `clientMsgId` 透传用例。
真机 CDP 实测：查找条给出"仅搜已加载的 1 条"/"无匹配"、行菜单打开且置顶/静音写进 localStorage 并点亮图标、
取消后回到 `{}`。**未真机验证**：群成员数（灰度范围内还没有群）、静音圆点（需要真的未读）、
失败重试（不想给同事发测试消息；失败态由 jsdom 用例覆盖、`clientMsgId` 复用由服务层用例覆盖）。

### 12.8 按设计稿补齐四区 + 建立视觉系统（2026-10-18）

用户反馈"客户端还是太简单、UI 完全简陋、不协调"之后，做了一次**先看像素再改**的返工。
对照 `im-ui-directions.html` 的 C 方案逐项补齐：

| 设计稿元素            | 之前       | 现在                                                                |
| --------------------- | ---------- | ------------------------------------------------------------------- |
| `.rail` 第一栏        | 无         | 56px 图标栏（消息 / 通讯录）+ 底部本人头像 + 未读角标               |
| `.pane .cat` 列表分组 | 平铺       | 置顶 / 单聊 / 群聊分组标题（搜索时不分）                            |
| `.members` 右栏       | 群设置表单 | 成员面板：在线 / 离线分组、头像、部门、群主标记；设置收进右上角入口 |
| `.toolbar` 悬停工具条 | 只有撤回   | 回复 / 转发 / 复制 / 撤回（撤回只在自己消息上）                     |
| `.sys` 系统消息       | 无         | 居中胶囊行，文案客户端 i18n 渲染                                    |
| 引用块（B 方向）      | 无         | 消息里显示被引用者 + 摘要，点击跳回原消息（滚动 + 短暂高亮）        |

**视觉系统** `packages/ui/src/im/imChrome.ts`（一处定义、四个区共用）——"不协调"的根因是每个组件各写一套：

- **两级底色**（用主题 token，不新造颜色）：导航 chrome（rail / 列表 / 右栏）= `bg-sidebar` #161616，
  内容 canvas（消息列）= `bg-background` #0f0f0f。之前全是同一个 #0f0f0f，只靠 hairline 硬撑。
- **间距节奏 4/8/12/16**；行高统一（列表行 56 / 成员行 44 / 区头 48）；字号四档（13 名称 / 12 次要 / 11 时间 / 14 正文 22 行高）。
- **选中态用灰面 + 左侧 2px 强调条**，不再用蓝色 accent——蓝色只留给未读，否则"选中"和"未读"抢同一个信号。
- **消息列贴底**（`min-h-full justify-end`）并对内容加 `max-w-3xl`：面板可能被拖到 1000px+，正文不能拉成一行 200 字。
- **消息列表头去掉重复标题**：面板 tab、列头、列表头三处都写"消息"是廉价感的主要来源；列表头只留"能做的事"（搜索 / 新建 / 刷新）。

**三个真 bug（这轮引入/发现）**：

1. **hooks 顺序**：把 `useMemo` 放在早返回（未加载 / 无权限）之后 → 真机报
   `Rendered more hooks than during the previous render`，整块面板进错误边界。教训：早返回之前的所有 hook 都必须无条件。
2. 新文件（`imChrome.ts` / `ImDirectoryList.tsx`）在 dev server 运行期创建后，Vite 模块图解析失败
   （报"自己 import 自己"）→ 面板空白；**重启 dev** 即恢复。新增文件后如果界面整块空掉，先怀疑这个。
3. 消息列不贴底（历史消息堆在顶部、下面一大片空）——这是"看起来不像成熟 IM"的直接原因之一。

**服务端（msgbus）同步扩展并已部署生产**（`docker compose -p ucas-proxy-prod build msgbus && up -d`，
注意生产部署目录是 `/home/services/ucas-proxy`，不是 `/root/ucas-proxy`）：

- `messages.reply_to_id` 用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 原地迁移（启动即执行，幂等）；
  读取侧**自连接**出引用摘要（客户端不必回查，被引用的那条可能不在已加载的一页里）；
  引用目标必须同会话（跨会话引用会让引用块泄露另一个会话的内容）。
- **系统消息** `kind='system'`，body 是 **JSON 载荷**（谁做了什么），文案由客户端按语言渲染——
  把中文写进库里等于把语言钉死在服务端。建群 / 加人 / 移除 / 退群 / 改名各记一条，与普通消息共用 seq 分配。
- **成员详情 + 在线**：`GET /:id/members` 增加 `details`（角色 / 加入时间 / online），`members` 字符串数组保留兼容；
  在线状态由 hub 的活连接判定（**多端登录时关掉一端不算离线**）；上下线时向该用户所在会话广播 `presence`，
  客户端只更新那一个人（不重拉全量）。
- 实测：msgbus 4 套件 **67 条**（新增 11 条：引用校验/预览、系统消息 seq 与顺序、成员详情、presence 上线下线、多端）；
  生产 `GET :id/members` 200 且 `details[me].online === true`（桌面端连着新 WS），客户端成员面板实测 1 个在线点。

**仍未做**：表情回应（需要新表 + 端点 + WS 聚合）、附件/图片预览（上传管线）、正在输入。
这三项里"表情回应"是设计稿 `.toolbar` 上唯一还没落地的按钮——没有把握就不放死按钮。

### 12.9 设计稿最后三项：表情回应 / 附件与图片 / 正在输入（2026-10-18）

**表情回应**（设计稿 `.toolbar` 上那个"表情"按钮）

- 表 `message_reactions(message_id, user_id, emoji)`，主键就是三者的组合——**重复点同一个表情幂等**，
  计数永远由行数算出来，不存冗余的 count 列。
- **协议不带 `mine`**：那是"看的人"视角的标记，同一个载荷广播给不同的人会串（谁点的就以为自己也点过）。
  服务端只给事实 `{emoji, count, userIds}`（userIds 截断 20 个），客户端自己算高亮。
  这条是被测试逼出来的：广播帧带着 `mine: true` 发给别人，对方会看到自己"点过"。
- 客户端：工具条给一屏放得下的常用表情（👍🎉✅👀🙏😅），不做完整 emoji 面板；
  消息下方是 chip（emoji + 计数），自己点过高亮，点击即切换。

**附件与图片**

- **元数据入库、字节落卷**（compose 新增 `msgbus-uploads:/data/uploads`）。不塞 `bytea`：几十 MB 的图片
  进 PG 会拖垮 autovacuum 与备份；也没有可用的对象存储桶，先落卷，换实现只动 store 一层。
- 上传用 **raw body**（文件名/类型走 `x-file-name`/`x-file-mime`），不引 multer 依赖；
  先写文件再登记，登记失败删文件（否则卷里会留下没人认领的字节）。单文件上限 20 MiB。
- 消息 `kind='attachment'`，body 是 `{"attachmentId","name","mime","size"}`：后三个是发送方上传完
  就已知的展示信息（省一次回查），**服务端只校验 attachmentId 属于本会话**——跨会话引用会被 400 拒掉，
  否则可以把别处会话的文件贴进来。
- 下载 `GET /api/attachments/:id` 带成员校验；**字节用带鉴权的 fetch 取成 blob 再喂 `<img>`**，
  不能把 URL 直接给 `<img src>`（带不了 Authorization，塞 URL 里又会进日志）；object URL 用完即释放。
  图片（png/jpeg/gif/webp/bmp/avif）内联，**SVG 不内联**；其它一律文件卡片，点击下载。
- 本机"用 App 打开"没有做成：需要新增平台能力（本机落盘 + `openExternalFile`），现有的
  `materializeWorkflowArtifactFile` 是 workflow 专用，不适合借用。当前行为是浏览器下载语义。

**正在输入**

- **不落库、不进 seq**：客户端节流 3 秒发 `{type:'typing'}`，服务端校验成员资格后只转给会话里的其他人，
  接收侧 4 秒没有新帧就自己消失（撤销帧不值当）。多端登录时过滤掉自己的 id（"你正在输入"没有意义）。

**这一轮新增的测试**：服务端 74 条（+7：表情聚合与幂等、非成员 403、附件上传/下载/跨会话引用/空上传、
typing 转发与拒绝、回应广播）；客户端 184 条相关用例（+20：chip 与高亮、附件三种渲染分支、
表情/typing 帧的客户端接线、typing 离线静默）。

**生产验证**（部署镜像里跑，不是在本地）：临时 schema 里跑完整 store 冒烟——引用预览、回应聚合
（`count: 2, userIds: [对方, 我]`）、系统消息与普通消息共用 seq（1,2,3）、附件元数据与成员校验、
跨会话引用被拒；再用 HTTP 探路由语义：随机消息加表情 404 not_found、空上传 400、随机附件 404、无令牌 401。
**未做的真机验证**：两个真人之间的表情/附件/输入中往返（需要同事在线配合），以及被遮挡窗口下的像素复核
（截图是旧帧，一律以 DOM 为准）。

### 12.10 两方联调：插一个测试账号 + 第二个协议客户端（2026-10-18）

用户建议："插入一个测试用户，新开一个实例，在两个用户之间测试"。落地方式比开第二个桌面端更省事，
而且**用的是同一套协议**：

1. **测试账号**：往 control-plane 的 `users` 插一行
   `id=11111111-2222-4333-8444-555555555555`、`wecom_userid=uwork.imtest`、`name=IM 测试账号`、
   `department=测试与服务保障部`（落在灰度部门里 → 不需要改 env、不用重启就能进白名单快照，
   60 秒后 msgbus 的 `allowlistUsers` 从 17 变 18）。
   **移除办法**：`DELETE FROM users WHERE id='11111111-…'`，等快照过期即恢复。
   注意：它会出现在另外 16 人的通讯录里（白名单内的可见性是对称的），名字带"测试"便于识别。
2. **对端客户端** `services/msgbus/scripts/im-peer.mjs`（dev 工具，不进镜像）：
   用同一套 REST + WS 协议扮演"另一个人"——`whoami / dm / send / reply / react / attach / typing /
withdraw / listen`。在 msgbus 容器里跑最省事（那里有 JWT_SECRET、也够得着 3010）。
   于是本机的一个真实客户端就能把所有**入向**路径看全（收消息、别人正在输入、别人点的表情、
   别人发的图片、建群产生的系统消息），不用请同事配合。

**两方联调当场抓到的三个真问题**（都是自测发现不了的）：

1. **别人点的表情不显示**：service 更新了自己的缓存并转发了 `message_reactions` 事件，但面板 hook
   （`useImConversation`）没订阅这个 kind → React state 没变、UI 不重绘。**本地点击也一样不显示**
   （服务端不过滤发起端，所以两条路径共用同一个修复）。
2. **新端点 404，看起来像"功能没实现"**：内层 nginx 只把 `/api/conversations` 转给 msgbus，
   新加的 `/api/messages`（表情）与 `/api/attachments`（附件）落到了 control-plane。
   外层 1Panel openresty 是 `location /` 全转发（含 Upgrade），所以**只缺内层两段**；
   附件那段的 `proxy_buffering off` + `client_max_body_size 25m` 也一并配了。
3. **会话列表把系统消息的 JSON 当预览**：`IM: {"action":"member_left",...}` 直接显示给用户。
   预览统一收口到一个函数：系统消息 → 人话、附件 → `[图片]/[文件] 文件名`、其余走原文案，
   搜索过滤也走同一个口子（否则搜索会去匹配 JSON）。

**已验证的路径**（桌面端真实 UI + 对端脚本）：入向消息与三处未读角标（行/rail/侧栏入口）+
「以下是新消息」分隔线；正在输入（收 + 发）；表情（别人点 → chip 高亮为 false、自己点 → 变 true 且计数 +1）；
图片附件（内联，blob URL + 鉴权 fetch，实测 240×120 原图）；引用回复（引用块显示"辛晓华 | 原文"并可跳转）；
系统消息三连（创建群 / 改名 / 退群，都是人话胶囊）；我方发送到达对端（对端 `listen` 收到 `typing` 与
`message` 帧、seq 连续）。

**测试与清理**：服务端 74 条、客户端相关 215 条全绿。联调产生的数据只在我与测试账号之间
（DM + 一个两人群），同事看不到；重复发出的那条测试消息已撤回。

### 12.11 把"测试太浅"补上：全历史检索 / 文件传输 / 分页补洞（2026-10-18）

用户指出「测试得太简单了，包括文件的发送下载、历史信息检索」。逐项补完，并且补出了真 bug。

**全历史检索（原来是假的）**：之前的"会话内搜索"只在**已加载的那一页**里过滤——几百条之后等于什么都搜不到，
却看起来有搜索。改成打服务端：

- 表加 `pg_trgm` + `GIN(body gin_trgm_ops)`：中文没有词边界，全文检索（tsvector）反而搜不到子串。
  **注意顺序**：扩展必须先建，索引才能用它的 operator class；且 `CREATE EXTENSION` 是**库级**对象，
  多实例/多测试并行会撞（42710/23505/XX000），必须容忍；**还要显式 `SCHEMA public`**，
  否则 search_path 指向测试 schema 时会把扩展装进那个 schema，别的 schema 再建索引就报
  "operator class gin_trgm_ops does not exist"。
- `GET /api/conversations/:id/messages/search?q=&before=&limit=`：按 seq **倒序**（最近命中优先），
  `before` 继续往前翻；`ILIKE` 的通配符要转义（用户搜 `%` 不能变成"匹配全部"）；撤回的不进结果。
- 客户端：结果列表（发送者/时刻/高亮片段）+「继续往前找」；点命中 → `loadAround(seq)` 拉上下文窗口 →
  滚动 + 高亮 2.5 秒。**`loadAround` 必须由 hook 做**：service 只更新自己的缓存，界面读的是 hook 的 state，
  第一版只调了 service，实测"点了没反应"。
- 跳转的滚动要**测量后纠正**：StickToBottom 在内容变高时会贴底，它那次贴底会把 `scrollIntoView` 盖掉
  （实测高亮了但行在视口上方 1235px）。滚完量位置，不对再滚，最多三轮。

**文件发送/下载**：

- 字节一致性：3 MiB 确定性数据 → 桌面端 UI 上传 → 对端脚本下载 → **sha256 完全相同**；
  5 MiB 也过了（jest 里 sha256 比对）。中文名 + `../` + 空格 + 括号原样往返；路径不穿越
  （落盘名是随机 id + 扩展名）；超限 413；登记失败（非成员上传）不留孤儿文件。
- **`kind` 之前根本没传到服务端**：客户端发的 `kind` 在协议里不存在，服务端一律按 text 存，
  于是附件消息在界面上显示成一串 JSON。补上 `send.kind`，并且**服务端只接受 text/attachment**——
  让客户端指定 `system` 就等于允许伪造"某某把群名改成了 X"。
- **下载按钮在桌面端是坏的**：渲染层 `<a download>` 在 Electron 里不会真的落盘（实测点完磁盘上什么都没有）。
  新增宿主能力 `saveImAttachment`（写入"下载"目录下的 UWork 子目录，同名不覆盖，返回路径），
  由 `desktopPlatform` 转发给 UI；网页端没有这个能力时退回浏览器下载语义。
  实测：点文件卡片 → `~/Downloads/UWork/联调 大文件 v3.bin`，3,145,728 字节，sha256 与本地一致。

**历史分页与补洞**：主流 200 条实测——`before` 翻三页无重无漏（50+50+50 拼回 200 条）、
`since=150` 只回 151..200；UI 上「更早的消息」50 → 100 → 150 三页正常。

**顺带修掉的测试自身问题**（这轮最费时的部分）：

1. **用例竞态**：WS 的 presence 用例"先连 socket 再挂等待"，上线帧在监听器挂上之前就送到了 →
   表现为 1/3 概率"随机超时/401/404"。修法是**先挂等待再触发动作**（同一条经验在表情广播用例里已经用过一次）。
   修完 24 次连续全绿。
2. 测试脚手架的收尾：`close()` 前等一拍，让 fire-and-forget 的广播落定，别打在已关闭的池上。
3. 测试数据库里积了 394 个没删掉的临时 schema（历史失败留下的），清掉。
4. 造历史的用例改成直接调 store（200 次 HTTP 往返只会让别的用例跟着变慢，制造假失败）；
   各套件之间不要再共用"已结束的池"。

### 12.12 右键菜单：消息 / 会话 / 附件 / 文本（2026-10-18）

用户反馈"消息里头完全不能右键，右键全部都是 inspect element"。原因有两层：

1. 应用**只有**原生文本菜单（主进程 `context-menu` 里 `buildTextContextMenuTemplate`），
   且仅在文本编辑语义下才弹；消息/会话/附件这些区域既没有 DOM 菜单、也没有原生菜单，
   于是 dev 下只剩一个 Inspect Element，生产下则**什么都没有**。
2. dev 的 Inspect Element 是无条件挂上的，所以"右键永远只看到它"。

**修法**：区域菜单用应用自己的 DOM 菜单（仓库已有 Radix `ContextMenu`），dev 的 Inspect 挪到 **Alt+右键**。

| 区域               | 菜单项                                                 |
| ------------------ | ------------------------------------------------------ |
| 消息行（别人的）   | 回复 / 转发 / 复制                                     |
| 消息行（自己的）   | 回复 / 转发 / 复制 / 撤回                              |
| 消息行（有引用时） | 上面这些 + 跳转到引用的消息                            |
| 会话行             | 置顶 / 取消置顶、静音 / 取消静音、（有未读时）标记已读 |
| 附件（图片与文件） | 保存到本机                                             |

两条判断：

- **右键里的撤回是"点击即撤"**，悬停工具条里仍是**两步确认**。菜单点完就关，做不了"再点一次确认"，
  两步在这里只会让人以为没生效。两种入口的行为差异写在 `useImWithdraw.ts` 里。
- **原生文本菜单要保留**：可编辑区/选中文本仍走主进程的原生菜单（复制/粘贴/全选），
  DOM 菜单只在"非文本编辑"的目标上出现，两边不打架。

**另一个小坑**：`ContextMenuTrigger` 包住会话行时，行内还有一个 DropdownMenu 的"…"按钮，
两套菜单的触发区域会重叠——右键落在按钮上时是行菜单（按钮只响应左键），实测正常。

**实测**（真机，CDP 派发 contextmenu）：消息行 `["回复","转发","复制"]`、自己的消息
`[...,"撤回"]`、会话行 `["置顶","静音"]`（无未读时不显示"标记已读"）、
有未读时 `["置顶","静音","标记已读"]` 且点完行角标从 1 变 null、rail 角标同时消失、
附件 `["保存到本机"]`。jsdom 侧补了消息行右键用例（别人/自己两种菜单项与回调）。

### 12.6 怎么在真机上验证桌面 UI（不用 GUI 自动化）

dev 起来的 Electron 渲染进程自己开着 CDP：`http://127.0.0.1:9229/json/list` → 取 `title === "UWork"`
那条的 `webSocketDebuggerUrl`，用 Node 内置 `WebSocket` 就能 `Runtime.evaluate` 读 DOM、
`Input.dispatchMouseEvent` 点按钮、`Page.reload` 重载。写脚本时必须知道的三件事：

1. **截图在窗口被遮挡时是旧帧**（`Page.captureScreenshot`，`fromSurface:false` 也一样），
   里面的内容可能停在几分钟前；**判断界面是否正确一律以 DOM 为准**（`outerHTML` / 几何 / `innerText`）。
2. 用 `Runtime.evaluate` 里的 `element.click()` 就能触发 React 的 onClick；**Radix 菜单不吃 `click`**，
   要给它 `pointerdown`+`pointerup`+`click` 三个事件，或者先 `focus()` 再发 `keydown Enter`。
   `Input.dispatchMouseEvent` 在被遮挡的窗口里不生效，别用它排查"点了没反应"。
3. 排错先 `Runtime.enable` + `Log.enable` 再 `Page.reload`，把 `exceptionThrown`/`consoleAPICalled`
   收下来——比盯着 DOM 猜快得多。
4. **被遮挡的窗口里 `document.visibilityState === "hidden"`，rAF / 截图 / 合成帧全部停摆**。
   判断"界面到底渲染了没"要看 DOM 而不是像素；真要用像素，先让窗口到前台。
5. 要复现"rAF 死掉"的环境：`Page.addScriptToEvaluateOnNewDocument({ source: "window.requestAnimationFrame = () => 1" })`
   再 `Page.reload`，此时点开右侧面板若仍然可见，说明可见性提交没有依赖那一帧。
   注意注入是**按 CDP 会话记账**的，`removeScriptToEvaluateOnNewDocument` 必须在同一会话里调用，用完记得 reload 清掉。

## 相关文档

- `specs/mobile-web-control-self-hosted.md`（relay 自建、加固清单、出境连接清单、手机页托管）
- `docs/bots.md`、`docs/bots-feishu-group-collaboration.md`（P2 的 agent 成员复用点）
- `UI_PLUGIN.md`（为什么 IM 不走插件路径）
