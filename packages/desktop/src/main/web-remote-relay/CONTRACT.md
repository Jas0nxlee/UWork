# desktop-web-remote-relay

将 Main 的 HTTP、存储和 device WebSocket 与 manager 装配隔离。

index.ts/contract.ts 与既有 desktopMobileRemoteControlConfig.ts 配置入口供外部消费。随包配置只提供 relay 与手机页入口值，不持有 attachment 或会话状态；其解析、路径和覆盖优先级由 desktopMobileRemoteControlConfig.test.ts 验证。manager 仍唯一拥有 window runtime 与 attachment；transport 唯一拥有 socket/generation。storage 只保存非敏感身份，clearLegacy 合并并发且失败可重试。凭据从注入端口读取，HTTP 错误只返回分类。

完整语义见 [Relay V2 spec](../../../../../docs/web-remote-control/relay-v2-pairing.md)。

UWork Main 显式注入 hmacRelay：socket 由 HMAC adapter 所有、配对凭据由既有 credential/settings 存储所有，manager 保留窗口/attachment lifecycle。HMAC 不读取 OAuth 或企业身份，缺失自建端点时失败关闭；既有 V2 clearLegacy 仅用于显式 V2，不清理 HMAC 凭据。HMAC stop 保留配对，resetPairing 撤销 socket 后清理配对再启动。

认证/持久化 ports 与 socket 事件/timing options 分别位于 contracts/hmacIdentity.ts 和 contracts/hmacTransport.ts；公开 contract.ts 统一导出，避免把两种协议的 socket 回调与认证命令混成一个庞大服务接口。自建 relay 每 SID 单 device 槽，因此现有窗口 registry 是唯一 owner；start 新窗口先撤销旧窗口生命周期，所有配对 IO 经同一串行入口并复验 controller。
