# HTTP Server 监听和认证边界

## 产品规则与所有者

- createHttpServer 是 HTTP/WebSocket 监听与认证中间件的唯一装配入口。未显式配置 host 时绑定 127.0.0.1；localhost、有效 127/8 IPv4 和 ::1 是回环地址。
- 显式非回环（包括所有网卡、局域网地址和其它 hostname）必须提供非空 authToken，否则在 listen 前同步拒绝。环境变量由 entry-http 解析传入，独立 factory 不用另一环境变量冒充已启用认证。
- server-info.authRequired 唯一由实际 authToken 决定；保留 options 兼容字段，但不能改变真实门禁。日志显示实际绑定地址及随机端口，IPv6 使用方括号。
- 现有 token cookie/API/WebSocket 认证和一次性 Host capability 语义保持。desktop-continuous 与 web-remote-replayable 的路由保持现有实现，不为网络暴露更换业务所有者。

## 接口与验收

1. 默认真实监听地址为 127.0.0.1，回环未配置 token 时允许本机开发访问。
2. 非回环无 token 或只有空白 token 均在 Server.listen 前失败；配置 token 后可显式绑定，未认证 API/capability 为 401，正确 token 为 200。
3. options.authRequired 或环境里的其它 token 名称不会让 server-info 谎报认证状态。
4. 使用端口 0 的真实 HTTP 测试，无外部网络访问、不执行文件或命令 RPC。
5. Desktop connector 的真实 WebSocket 回归保留 capability 一次性消费、token 贯穿和资源反向 RPC 的身份路由；监听夹具等待 listening 事件，不依赖省略 hostname 时地址同步可用的偶然行为。
