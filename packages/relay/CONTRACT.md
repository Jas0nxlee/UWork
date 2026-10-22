# relay 模块契约

自建 Web 远控中继（`@zcode/relay`）。行为契约、协议表与加固清单见
`specs/web-remote-control-relay.md`；本文件只说明这个模块对外承诺什么。

## 职责

`RELAY_RESPONSIBILITIES`：注册设备、配对鉴权、应答心跳、按配对关系透传 `data`。
relay 不解析 payload、不存会话、不持有任何 UWork/企业身份，也**不属于桌面 Release 产物**
（`packages/desktop` 不依赖它，打包脚本不引用它）。

## 直接依赖契约

- `shared`：消息形状、`WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS`、1 MiB 帧上限常量。
  协议改动必须先改 shared，relay 侧不允许复制粘贴类型。
- 运行期外部依赖只有 `ws`；落盘用 node:fs，鉴权用 node:crypto。

## 公开入口

`src/index.ts`（module.ts 的 `publicEntrypoints`）：

- `createRelayServer(config, { logger? })` → `RelayServer`（`listen` / `close` / `health` / `hub`）。
- `readRelayConfigFromEnv(env?)`、`createRelayConfig(overrides?)`、`RELAY_DEFAULT_CONFIG`。
- `calculateRelayAuthProof` / `verifyRelayAuthProof`：与 shared 向量逐字节一致的鉴权原语。
- `RelayDeviceStore`：`sid → pass_hash` 落盘（重启后旧二维码不失效）。

`contract.ts` 另导出 `RELAY_RESPONSIBILITIES` 与 `RELAY_ERROR_SEMANTICS`（错误码语义表）。

## 示例与测试

- `contract.example.ts`：`startExampleRelay()` 起一个内存态 relay 并给出 ws/http 地址。
- `test/contract.test.ts`：示例可启动、鉴权向量一致、错误码语义覆盖 shared 的全部 code。
- `test/relayAuth|relayPairing|relayTransportLimits|relayPersistence|relayOps|relayClientContract.test.ts`：
  协议状态机、失败面、限制、落盘、运维面，以及**真实手机端 transport 打到真实 relay** 的集成回归。

## 不承诺

- 不做多实例横向扩容（单实例内存态房间 + 落盘；扩容需按 `mid`/`device_sid` 粘滞路由）。
- 不做访问控制产品（不做企微登录、不做白名单）；凭证轮换与强制断开见 spec 第六、七节。
- 不保证背叛协议的对端可用：字段形状以 shared 类型为准。
