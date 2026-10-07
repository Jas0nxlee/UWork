# 企业微信登录对接

## 现有服务的组织 state 兼容

服务前端将回调 state 传给 login(code, org_id)，因此 state 使用服务的组织 ID。CorpID 与 orgId 不是同一标识：必须配置 orgId，并在后台 code 交换时发送它。只在公开组织列表中存在唯一匹配 CorpID 的组织时自动绑定。

每次桌面尝试仍生成随机 UUID；redirect_uri 在原有 HTTPS 回调地址后携带唯一的 uwork_nonce，UWork 校验该值、state=orgId、精确 origin/端口/path 和唯一 code。主窗口内的独立 sandbox WebContentsView 在顶层或 iframe 回调加载前截获，防止受控页面先消费 code。后台服务与网页不做任何修改。

独立企微客户端或系统浏览器中的回调不受 UWork 控制，网页可能自行登录；只有测试进程确认接回绑定回调并完成后台 code 交换，才能报 UWork 真实认证通过。

UWork 提供可跳过的企业登录入口与姓名展示，并在登录后复用同一认证服务的后台能力自动配置模型网关。Desktop 已接入标准自建应用 Web 扫码与现有认证服务适配器；缺少本机配置时界面明确显示未配置，不会以模拟身份替代真实登录。网关自动配置只在正式登录成功或设备会话恢复后触发，跳过登录、只读手机 attachment 与认证失败都不调用企业后台。

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

Desktop 使用内嵌 sandbox 扫码视图截获严格绑定的 HTTPS 回调，在网页消费 code 前阻止加载，然后由 Host 调用现有登录接口。因此不需要读取网页存储的 Token，也不需要新增业务轮询接口。接入前需要确认：

- 自建应用的 CorpID、AgentID，以及企业后台实际生效的回调域和端口。
- 服务端的 code 交换支持该自建应用，后台实际回调端口匹配；不能仅使用姓名、企业微信用户 ID 或公共 URL 作为登录证明。
- 已有认证接口的用户 ID、企业 ID、姓名、Token 有效期与续期/吊销错误码；Secret 通过后端安全配置提供，不写入聊天、客户端或仓库。

## 客户端契约

现有服务适配为 `EnterpriseIdentityAdapter` 的 start/complete/restore。实现由 Node 装配层加载；poll 和远端 revoke 为可选能力，已有轮询适配器保持兼容。没有虚构的轮询或吊销接口。

start 返回官方新版 Web 登录 URL、绑定当前尝试的 id/state、callbackUrl、expiresAt。complete 只在严格验证回调后用 code 调用 POST /api/auth/login。响应需包含 token、user.id、user.org_id、user.name，组织必须与配置一致。needsEmailAuth=true 表示现有网页会尝试补充邮箱授权；UWork 本期仅用姓名，此时先请求已有 refresh 接口，服务确认同一用户和组织的有效会话后才允许完成登录。JWT exp 只用作有效期，不用本地解码替代认证。restore 通过 POST /api/auth/refresh 经服务端验证后返回新 session；401/403 清理，网络错误保留加密记录供重试。

2026-09-29 的隔离原生扫码测试已完成真实 code 交换、服务端 refresh 和加密会话保存；另一个新测试进程恢复该会话成功。后续修正了 Host 准备前缺少备用 cwd 的启动问题。最终正式安装包通过启动和跳过登录验证，并按用户授权替换本机 UWork；实际安装版自动恢复登录，主界面真实姓名已确认显示在 Logo 下方。真实多窗口退出同步尚未完成验证。

IdentitySessionStore 用跨 Host 文件锁和全局 revision 持久化设备共享账号。登录/退出只广播 revision，其他窗口读取事实并由后端验证后更新姓名；续期不广播，Token 条件写入防止回环和覆盖。Host 只向 Renderer 发布无凭据视图。开始、取消、跳过、退出后的旧响应不能写入新状态；登录页用覆盖层保留草稿。手机 attachment 只投影已有 Local Host 身份。

## 登录后的企业网关自动配置（2026-10-04）

认证服务与模型网关同源：`enterprise-identity.json` 的 `apiBaseUrl` 同时作为 control-plane API 根地址，`llm_base_url(_internal)` 由 `/api/auth/orgs` 下发。登录成功（或设备会话恢复、用户手动同步）后，Host 内的 UcasGatewayService 依次：

1. `POST /api/auth/refresh` 读取用户资料（姓名、部门、职位、邮箱、头像、角色、月度预算）。
2. `GET /api/keys`：有 active Key 则 `GET /api/keys/{id}/reveal` 复用；没有则 `POST /api/keys/generate`（别名 `UWork`）生成，Key 明文只在内存与 Provider 配置中出现。
3. `GET /api/auth/orgs` 取公网 / 内网入口；先探测内网 `{llm_base_url_internal}/v1/models` 是否可达（任何 HTTP 响应都算可达），不可达才回退公网。
4. 写入默认 `ucas` 供应商：Base URL 采用解析出的端点（含 `/v1`），API Key 只在本地为空时补录，模型按第 5 步结果追加。
5. `GET /api/usage/models` 取套餐可用模型；`models` 为空且 `unrestricted=true` 时改读网关 `{baseUrl}/v1/models`。之后 `GET /api/usage` 与 `GET /api/usage/stats` 取套餐额度与用量。

规则与边界：

- 已有本地 API Key 不被自动覆盖；面板上的「使用企业密钥替换」才覆盖。退出登录不清除已写入的 Key 与网关地址。
- 模型同步只追加缺失项，不删除、不改参数、不改顺序；重复执行幂等。
- 内网地址探测结果与 Key 元数据写入 `{dataBaseDir}/.zcode/v2/ucas-gateway.json`（原子私有写 + 文件锁），供下次启动播种 UCAS 固定地址；文件不含 Key 明文。
- 套餐与用量为只读展示；本期不提供购买、重置额度或撤销 Key。
- 日志与错误文案不写入 Key 全文、JWT 或内网地址。
- 展示位置：**设置 → 使用统计 → 企业网关**（账号、网关、套餐、用量、模型），UWork 字标下的身份菜单提供「同步企业配置」与直达入口。
- 只读手机 attachment 不触发登录后的自动同步，但可查看桌面 Host 已同步的网关数据；普通 Web 的行为由所连接的 Host 决定，旧 Host 未注册该服务时面板显示「当前 Host 不支持」。

## 发布默认配置与本机覆盖

正式 GitHub 安装包通过发布构建注入默认企业微信公开参数，保存于 `resources/config/enterprise-identity.json`，由 Desktop Main 将资源路径传给 Local Host。新设备安装后无需另放文件即可扫码。发布输入保存在 GitHub Actions 的 `UWORK_ENTERPRISE_IDENTITY_CONFIG` 加密配置中，不写入源码；严格 schema 仅允许下列五个字段，缺少配置或字段不合法会阻断发布，打包后逐平台验证资源内容。

管理员需要不同配置时，可在当前 dataBaseDir 下放置 `.zcode/v2/enterprise-identity.json`。Host 优先读取本机覆盖，文件不存在才读取随包默认；显式覆盖损坏时不静默换到默认组织。覆盖文件不随升级删除。Secret、用户 Token、登录会话和 UCAS Key 不属于公开配置。

```json
{
  "corpId": "ww-example-corp",
  "agentId": "1000001",
  "orgId": "issuer-organization-id",
  "apiBaseUrl": "https://auth.example.com",
  "callbackUrl": "https://auth.example.com/callback"
}
```

配置修改后重启 App。apiBaseUrl 必须为 HTTPS 根地址，callbackUrl 必须同源且无 query/hash。普通 Web 没有原生视图能力，本轮不自动启用此适配器；手机远控继续只读。

### Windows 安装与覆盖

从 `v3.14.7` 起，Windows 正式包携带默认配置，安装后企业微信按钮应可点击。Mac 登录会话不会复制到 Windows，每台设备仍需自己扫码。旧版安装包或没有注入默认配置的开发构建仍可按下列步骤放置本机覆盖。

1. 完全退出 UWork（包括系统托盘中的进程）。
2. 将已确认有效、仅含 `corpId`、`agentId`、`orgId`、`apiBaseUrl`、`callbackUrl` 的 `enterprise-identity.json` 复制到 `%USERPROFILE%\.zcode\v2\enterprise-identity.json`。若设置了自定义 `dataBaseDir`，目标改为该目录下的 `.zcode\v2\enterprise-identity.json`。保留 UTF-8 JSON 文件名，避免资源管理器隐藏扩展名后变成 `.json.txt`。已有目标文件先备份。
3. 重新启动 UWork；确认“暂未配置”提示消失且企业微信登录按钮可点击，再检查二维码与回调。若按钮仍灰色，核对实际数据目录、文件名与 JSON 结构。网络不可达或授权失败属于后续链路，不能用按钮恢复可点击代替真实登录验证。

不要复制 `credentials.json`：设备会话凭据按本机加密保存。随包默认配置仅包含公开参数，本机覆盖与任何凭据都不提交 Git，也不作为独立公开下载文件分发。

## 内嵌扫码展示

登录页通过平台接口发送已挂载二维码槽位的 bounds、主题颜色、字体和语言，Main 挂载独立 WebContentsView，不创建第二个窗口。内嵌地址完整沿用已验证成功的新版 Web 登录 URL，不能为展示改造转换到旧版 qrConnect；旧版入口在当前配置下已实测出现回调域不匹配。固定 CSS 只移除装饰性标题与外卡片，保持二维码对比度和授权状态；远端页没有应用 preload 或 Node 权限。授权文档切换后重新应用 UI zoom/CSS，窗口尺寸和主题更新不会重载二维码。规范与事件顺序见 [spec](../specs/enterprise-identity.md)。

## 验证边界

Node 测试使用注入适配器验证身份生命周期与竞态；共享组件浏览器 E2E 使用隔离 fixture 验证姓名与交互，不能作为真实企业微信登录证据。真实扫码必须在现有认证服务的测试环境完成，并核对当前回调配置。
