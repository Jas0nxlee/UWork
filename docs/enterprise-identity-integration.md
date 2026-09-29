# 企业微信登录对接

UWork 首期提供可跳过的企业登录入口与姓名展示，模型 API Key 和企业身份分开。当前没有生产认证适配器；界面明确显示未配置，不会以模拟身份替代真实登录。

## 标准企业微信流程

企业内部自建应用 Web 扫码授权：企业微信授权页面 → 企业已配置的 HTTPS 回调 → 服务端用 code 核验成员身份 → 读取有权限的成员姓名 → 为 UWork 签发会话。企业微信应用 Secret 和 access_token 均留在服务端。CorpID、AgentID 属于应用标识，可用于构造扫码入口；域名含非默认端口时，后台回调域需匹配实际端口。

官方文档：[扫码登录](https://developer.work.weixin.qq.com/document/path/91025)、[读取成员和姓名权限](https://developer.work.weixin.qq.com/document/path/90196)。网页授权链接的 snsapi_base 与桌面扫码授权是不同入口。

## 当前已有服务的证据与缺口

2026-09-29 对用户提供的网站进行了公开页面检查，没有登录或读取任何用户凭据。前端公开源码与未认证响应可确认：

| 接口                                            | 已确认用途                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| GET /api/auth/orgs                              | 可选择的组织标识列表                                                  |
| GET /api/auth/authorize?redirect_uri=…&org_id=… | 返回授权 url；当前构造的是微信内网页授权链接                          |
| POST /api/auth/login                            | 前端发送 code、org_id，消费返回的 token、user；姓名字段使用 user.name |
| POST /api/auth/refresh                          | 前端携带 Bearer 凭据续期并更新 token、user                            |

这些是公开前端的实际调用，并非完整服务端契约；尚未验证真实登录响应、有效期、稳定用户 ID、签名、会话吊销或桌面扫码链路。不能把网页自己的浏览器存储当作 UWork 登录凭据。

现有站点的回调页面接收授权结果后，还需要安全地交接给发起登录的 UWork 窗口。接入前需要确认：

- 自建应用的 CorpID、AgentID，以及企业后台实际生效的回调域和端口。
- 服务端是否支持标准 Web 扫码授权，以及一次性登录结果交接机制（轮询 ticket 或经校验的 App 回调）。不能仅使用姓名、企业微信用户 ID 或公共 URL 作为登录证明。
- 已有认证接口的用户 ID、企业 ID、姓名、Token 有效期与续期/吊销错误码；Secret 通过后端安全配置提供，不写入聊天、客户端或仓库。

## 客户端契约

现有服务适配为 `EnterpriseIdentityAdapter` 的 start/poll/restore/revoke。实现由 Node 装配层注入 createLocalServices 的 enterpriseIdentityAdapter；接口名称属于内部契约，不宣称已有网站提供同名接口。

start 返回 HTTPS authorizationUrl、绑定当前尝试的 id、expiresAt；poll 返回 pending、expired 或经过服务端验证的 session。session 包含稳定 profile.id、tenantId、provider=wecom、displayName、token、expiresAt（UTC 毫秒）。restore 返回经验证的新 session 或 null（已撤销/过期）；网络失败必须抛错，不能靠缓存姓名认证。

Host 加密保存会话，只向 Renderer 发布无凭据的 revision 视图。开始、取消、跳过、退出后的旧响应不能写入新状态；登录页用覆盖层保留工作区草稿，Esc 等价于跳过。手机 attachment 只投影已有 Local Host 身份。

## 验证边界

Node 测试使用注入适配器验证身份生命周期与竞态；共享组件浏览器 E2E 使用隔离 fixture 验证姓名与交互，不能作为真实企业微信登录证据。真实扫码必须在现有认证服务的测试环境完成，并核对当前回调配置。
