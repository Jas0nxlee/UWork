# UWork 手机远控装配修复

## 产品规则与所有者

- 手机 `/remote`（external relay、token bridge 和 disconnected home-only）只投影桌面已有 Host attachment；初始化/切换不自动恢复身份会话、不提供身份登录/退出入口、不触发自动企业网关配置。此装配标志不等于所有 RPC 的权限封禁；显式网关设置写入不在本次重构范围。
- 企业身份唯一写者仍是窗口 Local Host 的 enterprise identity service；workspace/session/runtime 及 accepted input 的所有者不变。手机不新建 Host、Agent 或独立远程会话。
- Root 将 workspace switcher、初始手机导航意图、初始 workspace/task 列表及 terminal transport 状态完整传至现有 RootWorkspaceContent → App → WorkspaceShellLayout。
- 窄屏使用现有 WebRemoteControlMobileShell；宽屏 Sidebar 使用同一个 switcher 的 listWorkspaces 全局任务索引，支持当前工作区任务和跨工作区切换。Sidebar 只保存折叠等局部 UI 状态。
- 桌面仅在远控已启用且状态 running/active、完整 workspace 恢复后发布工作区与任务列表投影；普通桌面不订阅整张 workspace 状态表。重连请求由已有桌面连接 owner 执行。
- UWork 已裁剪的 OAuth 账号、套餐、奖励及营销入口保持裁剪；远控修复不恢复这些产品入口。
- 手机 attachment 不挂载桌面首次职业/迁移引导；该偏好写入和完成状态仍属于已有桌面，不因 home-only 缺少设置而在手机上重新引导。

## 事件顺序与边界

```mermaid
sequenceDiagram
  participant D as Desktop Renderer
  participant H as 已有 Local Host / workspace runtime owner
  participant M as 手机 Root / Shell
  D->>H: 完整恢复后同步 workspace/task 投影
  M->>H: listWorkspaces（读取已有 attachment）
  H-->>M: workspace/task 列表及连接状态
  M->>H: switchWorkspace(workspaceIdentity key, taskId)
  H-->>M: 新 bridge + snapshot / replay
  M->>M: Root 全链路透传，进入 chat 或首页
  Note over D,H: desktop-continuous，实时链路不变
  Note over M,H: web-remote-replayable，snapshot + gap repair 不变
  Note over M,H: 企业身份初始化只读 getView；不发起登录、续期或自动网关同步
```

- 身份 key 继续使用 `workspaceIdentity?.trim() || workspacePath`；跨工作区切换通过现有 switcher，不用本地路径另建路由。
- 重建 bridge 后旧 Root 卸载，现有 switcher、任务索引和 replay 机制负责 stale result 与订阅清理；不增加超时或第二份 accepted queue。

## 验收与回归

1. 三种手机 Root 均显式启用企业身份只读；初次连接、跨工作区切换或 home-only 重建不显示企业登录，不调用 restoreSession/beginLogin/网关 sync。
2. Root 透传四项远控参数；手机保持 replayable workbench 模式，桌面保持 continuous。
3. 390px 手机首页可查看任务、打开当前任务、跨工作区切换；1200px 远控 Sidebar 使用全局任务索引，调用任务打开及切换中回调，隐藏 Automations，保留插件入口。
4. disconnected home-only 显示已有 workspace 列表并可重连；新 bridge 不新建 Agent/runtime。terminal reconnecting 提示保持现有手机壳语义。
5. 桌面远控关闭时不订阅全局任务表；开启时完整恢复后同步 pinned/timeline/archived 列表，重连请求转交既有连接 owner。
6. Zai Light / Zai Dark、中文/英文沿用已有组件与 DESIGN.md；窄屏/宽屏浏览器场景记录真实执行边界。

对应验证：Root 装配回归、手机入口只读装配回归、现有 workspaceSidebarWebRemoteMobileLayout / workspaceShellRemoteMobileLayout / webRemoteControlMobileShell 回归，以及真实 Web 入口浏览器场景。不得删除或跳过失败用例。

## 2026-10-14 浏览器验证边界

- `node packages/web/test/e2e/manual-review/pending/uwork-remote-integration.mjs`：真实 Web main → Root → 手机壳/宽屏 Sidebar；离线 relay 夹具首次握手、已有 disconnected workspace/task 投影、手机重连请求，390px / 1200px、Zai Light / Zai Dark 四种组合通过，无页面 JS 异常。
- `node packages/ui/test/webRemoteControlUworkFlow.e2e.mjs`：真实 MobileShell 与身份 Provider；当前任务打开、同路径不同 workspaceIdentity 的跨工作区切换并落到 chat、reconnecting 提示、只读身份初始化计数通过。
- 两者均使用 browser-harness。夹具不创建 Agent/Host，不连接企业微信、真实外部 relay 或 SSH；不能据此宣称真实配对、真实模型执行或端到端 runtime 验收。
- home-only 宽屏没有真实 attachment，底层 V4 subscribe 仍会记录 fail-closed warn；此场景只确认列表/导航展示和没有未处理 JS 异常，不宣称已建立可聊天 runtime。
- 中文消息按当前英文 key 补齐上游缺失译文，保留已有 UWork 定制值；空句式前缀按合法译文处理，覆盖检查使用键是否存在。
