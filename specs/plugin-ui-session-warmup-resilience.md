# 插件页面：会话暖启动窗口内的自愈

## 背景与问题（2026-10-14 真机复现）

应用**冷启动恢复上一次任务**时，渲染端会立刻为历史工具卡挂载插件页面；此刻会话的 MCP app 连接还没登记，host 的
`mcp/uiOpenInstance`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/protocol.ts`）拿不到连接快照，
直接回 `-32001 MCP App connection is unavailable`。

真机时间线（`chunk` 日志，应用启动后自动恢复任务）：

```
21:30:03.552  zcode-session.readSession FAIL  Session is not active: sess_952251ef-…
21:30:03.795  [plugin-ui] lifecycle { phase: 'preparing', scopeId: 'tool:call_…' }
21:30:03.807  plugin-ui-bridge.prepareSandbox FAIL  ZCodeProtocolClientError: MCP App connection is unavailable
21:30:03.815  [plugin-ui] lifecycle { phase: 'error', error: 'MCP App connection is unavailable' }
21:30:07.965  plugin-ui-bridge.callTool OK       ← 用户手点一次「重试」后页面才长出来
```

即：会话激活只要几百毫秒到几秒，而卡片在激活完成前就定了生死，把一次**瞬态**呈现成"加载失败"。

## 规则

- **R1 挂载期瞬态按瞬态处理**：`prepareSandbox` 阶段的"连接未就绪"（`code === -32001` 或消息
  `MCP App connection is unavailable`）由宿主页面层做**有界退避自动重试**（250/500/1000/2000/4000ms，共 5 次），
  期间保持 `preparing`（加载态），不落 `error`。
- **R2 有界、可取消、不掩盖真错**：预算用尽或 controller 已释放时，按原路径 `fail`，保留卡片上的手动重试；
  非瞬态错误（参数校验 `-32602`、资源被拒、握手超时等）不重试、立即失败。
- **R3 只改渲染端等待策略**：不改 `mcp/uiOpenInstance` 的语义（不引入服务端等待/长 RPC），不改 MCP Apps 协议，
  不影响非插件页面的路径。

## 状态所有者

- 等待策略：`packages/ui/src/plugin-ui/app/pluginUiWarmupRetry.ts`（可直接单测的纯策略 + 可注入 `sleep`/`isDisposed`）。
- 调用点：`pluginUiHostController.start()` 的 `prepareSandbox` 一处——卡片与侧栏共用同一条挂载路径，一处生效。
- 判定依据（为什么是瞬态而不是失败）：`readSession` 同一秒还在 `Session is not active`，说明是会话激活窗口；
  手动重试在 4 秒后成功，也印证连接随后被登记。

## 验收

- **A1 单测**：连续两次 -32001 后成功 → 按 250/500ms 退避重试并返回结果。
- **A2 单测**：非瞬态错误一次即抛，不等待。
- **A3 单测**：预算用尽（共 6 次调用）后抛出，落回 `fail`/手动重试。
- **A4 单测**：`isDisposed` 为真时不再等待。
- **A5 真机**：冷启动恢复带插件卡片的任务，卡片在会话激活后**自动**长出来（无需点重试）。

## 验证记录

- 2026-10-14 真机复现与时间线见上（用户报告"刚开始 unavailable，需要点击一下 retry"）。
- 单测（6/6 通过，`pnpm --filter @zcode/ui exec vitest run src/plugin-ui/app/pluginUiWarmupRetry.test.ts`）：
  A1 两次 -32001 后成功且退避为 250/500ms；A2 非瞬态一次即抛、不等待；A3 预算用尽共 6 次调用后抛出；
  A4 `isDisposed` 为真不多等；另两条覆盖"等待期间被释放"与瞬态判定（错误码/文案）。
- 根 `pnpm typecheck` 0 错误（`tsc -b` 全清单，含 `packages/ui`）。
- **A5 真机通过（2026-10-14 21:41 冷启动）**：重启实例后恢复带插件卡片的任务——`prepareSandbox FAIL -32001` 发生 1 次，
  日志出现 1 次 `[plugin-ui] MCP app connection not ready, retrying prepare`，随后 `phase: 'mounted'` 1 次；
  `[plugin-ui] host failed` 0 次、`physical assembly rejected` 0 次。用户侧无需再手点重试。
- 同轮顺带确认：`fault.subscription.recoveryFailed` 与本修复无关（成因是在运行中的实例下切分支导致的渲染端/host 混装，
  冷启动即清除，会话数据未损坏）。
