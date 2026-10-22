# @zcode/relay

自建 Web 远控中继（取代 ZCode 侧的 zcode-remote-hub）。**独立部署的服务，不属于桌面 Release**：
`packages/desktop` 不依赖它、electron-builder 的 `files` 只收 `packages/desktop/out/**` 并排除
`node_modules/@zcode/**`，两边没有任何引用关系。

行为契约、协议表、加固与凭证生命周期见 `specs/web-remote-control-relay.md`；
模块契约见 `CONTRACT.md`。

## 本地跑

```bash
# 开发态（tsx，热改即跑）
RELAY_PORT=8787 pnpm --filter @zcode/relay dev

# 单文件产物（运行期不需要 node_modules）
pnpm --filter @zcode/relay build
RELAY_PORT=8787 node packages/relay/dist/entry.js
```

冒烟：

```bash
curl -s localhost:8787/health
# {"status":"ok","version":"dev","uptimeMs":123,"rooms":0,"paired":0,"connections":0,"devices":0}
```

## 配置（全部走环境变量）

| 变量                                             | 默认           | 说明                                                                                                                                                                     |
| ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RELAY_HOST` / `RELAY_PORT`                      | 127.0.0.1:8787 | 容器里要设 `RELAY_HOST=0.0.0.0`                                                                                                                                          |
| `RELAY_WS_PATH`                                  | `/ws`          | 与桌面/手机共用的 WS 路径                                                                                                                                                |
| `RELAY_STATE_FILE`                               | 无             | `sid → pass_hash` 落盘；**不设就等于内存态，重启后旧二维码全废**                                                                                                         |
| `RELAY_ALLOWED_ORIGINS`                          | 空             | 手机页 Origin 允许列表（逗号分隔）。空 = 不校验，仅限本地调试                                                                                                            |
| `RELAY_ADMIN_TOKEN`                              | 无             | 配了才启用 `POST /admin/disconnect`                                                                                                                                      |
| `RELAY_TRUST_PROXY_HEADERS`                      | `false`        | **部署在反代后面必须开**：按 `X-Forwarded-For` 第一跳 / `X-Real-IP` 取客户端 IP。不开的话所有连接都算成反代那一个 IP，限流会互相误伤；只在可信反代后面开（否则头可伪造） |
| `RELAY_VERSION`                                  | `dev`          | `/health` 里回显，建议容器里注入提交号                                                                                                                                   |
| `RELAY_MAX_ROOMS`                                | 10000          | 已注册设备上限                                                                                                                                                           |
| `RELAY_MAX_CONNECTIONS_PER_IP`                   | 32             | 每 IP 并发 WS 上限（超出在升级阶段直接拒绝）                                                                                                                             |
| `RELAY_REGISTRATIONS_PER_MINUTE_PER_IP`          | 30             | 每 IP 注册速率                                                                                                                                                           |
| `RELAY_AUTH_FAILURES_PER_WINDOW_PER_IP`          | 60 / 10min     | 每 IP 爆破窗口                                                                                                                                                           |
| `RELAY_MAX_FRAME_BYTES`                          | 1 MiB          | 对齐 `WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes`                                                                                                     |
| `RELAY_MAX_BUFFERED_BYTES`                       | 4 MiB          | 每连接发送缓冲上限（超出丢帧不排队）                                                                                                                                     |
| `RELAY_IDLE_TIMEOUT_MS`                          | 90000          | 无上行流量才回收（等扫码的桌面每 10s 有心跳）                                                                                                                            |
| `RELAY_NONCE_TTL_MS` / `RELAY_MAX_AUTH_ATTEMPTS` | 60000 / 3      | 一次性 nonce 与尝试上限                                                                                                                                                  |

## 部署（不含域名/证书等环境信息）

```bash
pnpm --filter @zcode/relay build
docker build -t uwork-relay:$(git rev-parse --short HEAD) packages/relay
```

compose 片段（凭据与域名由部署环境提供，不要写进仓库）：

```yaml
services:
  uwork-relay:
    image: uwork-relay:<tag>
    restart: unless-stopped
    environment:
      RELAY_VERSION: <tag>
      RELAY_ALLOWED_ORIGINS: https://<手机页域名>
      RELAY_STATE_FILE: /data/relay-state.json
    volumes:
      - relay-state:/data
    expose:
      - "8787"
volumes:
  relay-state:
```

nginx 侧要点（同域、一张证书）：静态托管手机页 `/remote/v4`，`/ws` 用 `Upgrade`/`Connection`
反代到本容器；`index.html` 不缓存、`assets/` 可长缓存。若前置 CDN/WAF，要确认允许 WebSocket 长连接
（心跳 8~12s，30s ACK 看门狗）。

## 运维

```bash
curl -s localhost:8787/health
# 链接泄露/异常设备：强制断开该 sid（桌面会因此重新注册新 sid，旧链接随之失效）
curl -s -X POST localhost:8787/admin/disconnect \
  -H "authorization: Bearer $RELAY_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"deviceSid":"<sid>"}'
```

日志只记元数据（sid 后 4 位、role、错误码、计数），不记 payload、不记完整 sid、不记 pass_hash。

## 已知边界

- 单实例：房间在内存里，凭证落盘；横向扩容必须按 `mid`/`device_sid` 粘滞路由。
- 不做访问控制产品（企微登录、白名单不在范围内）；凭证轮换语义见 spec 第六节。
- 手机页静态托管与桌面指向自建入口（spec 的 P2/P3）不在本包内。
