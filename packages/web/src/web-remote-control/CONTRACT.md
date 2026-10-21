# web-remote-control

手机远控 admission、设备列表、transport 与只读页面。

入口通过 auth/HTTP/location/storage 端口操作外部状态；契约的设备分组与缓存展示类型不依赖实现。entry 的 AbortSignal 控制本次导航；transport 的 socket/generation 控制连接。只提取帧解析与独立请求关联，不创建第二份恢复 owner。Main/Host/CLI 继续拥有业务状态，手机仍为 replayable。

bootstrap 请求只读取响应。version guard 校验当前请求代际与版本后，同步通过 `onAccepted` 提交查看 epoch 等接受副作用；失效、释放或版本不匹配的回包不得产生该副作用。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。

UWork 默认在 Main/浏览器构建装配边界选择 hmac-v1；Entry 独立校验 SID/hash/t，不访问 OAuth/device/token API，缺少链接展示扫码页。官方 oauth-v2 必须显式选择，继续保持原账号门禁且拒绝 HMAC QR。两端共用原 bootstrap/目录/attachment owner，只有握手 transport 不同。HMAC 生产地址必须显式配置，默认官方端点失败关闭。
