# 企业微信登录对接

## 现有服务的组织 state 兼容

服务前端将回调 state 传给 login(code, org_id)，因此 state 使用服务的组织 ID。CorpID 与 orgId 不是同一标识：必须配置 orgId，并在后台 code 交换时发送它。只在公开组织列表中存在唯一匹配 CorpID 的组织时自动绑定。

每次桌面尝试仍生成随机 UUID；redirect_uri 在原有 HTTPS 回调地址后携带唯一的 uwork_nonce，UWork 校验该值、state=orgId、精确 origin/端口/path 和唯一 code。Native 窗口在顶层或 iframe 回调加载前截获，防止受控窗口中的网页先消费 code。后台服务与网页不做任何修改。

独立企微客户端或系统浏览器中的回调不受 UWork 控制，网页可能自行登录；只有测试进程确认接回绑定回调并完成后台 code 交换，才能报 UWork 真实认证通过。

UWork 提供可跳过的企业登录入口与姓名展示，模型 API Key 和企业身份分开。Desktop 已接入标准自建应用 Web 扫码与现有认证服务适配器；缺少本机配置时界面明确显示未配置，不会以模拟身份替代真实登录。

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

Desktop 使用独立 sandbox 登录窗口截获严格绑定的 HTTPS 回调，在网页消费 code 前阻止加载，然后由 Host 调用现有登录接口。因此不需要读取网页存储的 Token，也不需要新增业务轮询接口。接入前需要确认：

- 自建应用的 CorpID、AgentID，以及企业后台实际生效的回调域和端口。
- 服务端的 code 交换支持该自建应用，后台实际回调端口匹配；不能仅使用姓名、企业微信用户 ID 或公共 URL 作为登录证明。
- 已有认证接口的用户 ID、企业 ID、姓名、Token 有效期与续期/吊销错误码；Secret 通过后端安全配置提供，不写入聊天、客户端或仓库。

## 客户端契约

现有服务适配为 `EnterpriseIdentityAdapter` 的 start/complete/restore。实现由 Node 装配层加载；poll 和远端 revoke 为可选能力，已有轮询适配器保持兼容。没有虚构的轮询或吊销接口。

start 返回官方新版 Web 登录 URL、绑定当前尝试的 id/state、callbackUrl、expiresAt。complete 只在严格验证回调后用 code 调用 POST /api/auth/login。响应需包含 token、user.id、user.org_id、user.name，组织必须与配置一致。needsEmailAuth=true 表示现有网页会尝试补充邮箱授权；UWork 本期仅用姓名，此时先请求已有 refresh 接口，服务确认同一用户和组织的有效会话后才允许完成登录。JWT exp 只用作有效期，不用本地解码替代认证。restore 通过 POST /api/auth/refresh 经服务端验证后返回新 session；401/403 清理，网络错误保留加密记录供重试。

2026-09-29 的隔离原生扫码测试已完成真实 code 交换、服务端 refresh 和加密会话保存；另一个新测试进程恢复该会话成功。后续修正了 Host 准备前缺少备用 cwd 的启动问题。最终正式安装包通过启动和跳过登录验证，并按用户授权替换本机 UWork；实际安装版自动恢复登录，主界面真实姓名已确认显示在 Logo 下方。真实多窗口退出同步尚未完成验证。

IdentitySessionStore 用跨 Host 文件锁和全局 revision 持久化设备共享账号。登录/退出只广播 revision，其他窗口读取事实并由后端验证后更新姓名；续期不广播，Token 条件写入防止回环和覆盖。Host 只向 Renderer 发布无凭据视图。开始、取消、跳过、退出后的旧响应不能写入新状态；登录页用覆盖层保留草稿。手机 attachment 只投影已有 Local Host 身份。

## 本机配置

文件位于当前 dataBaseDir 下的 `.zcode/v2/enterprise-identity.json`，只由 Desktop Local Host 加载。使用企业管理员提供的公开标识，不包含 Secret，也不提交真实企业地址。

```json
{
  "corpId": "ww-example-corp",
  "agentId": "1000001",
  "orgId": "issuer-organization-id",
  "apiBaseUrl": "https://auth.example.com",
  "callbackUrl": "https://auth.example.com/callback"
}
```

配置修改后重启 App。apiBaseUrl 必须为 HTTPS 根地址，callbackUrl 必须同源且无 query/hash。普通 Web 没有原生窗口能力，本轮不自动启用此适配器；手机远控继续只读。

## 验证边界

Node 测试使用注入适配器验证身份生命周期与竞态；共享组件浏览器 E2E 使用隔离 fixture 验证姓名与交互，不能作为真实企业微信登录证据。真实扫码必须在现有认证服务的测试环境完成，并核对当前回调配置。
