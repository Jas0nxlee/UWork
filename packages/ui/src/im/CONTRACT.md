# im-ui

消息面板、未读投影和通知呈现。`IImService` 是消息与未读事实的唯一所有者；
UI 通过既有 workspace service hook 订阅视图并发送命令，仅维护编辑、选中和展示状态。

公开入口是 `contract.ts`、`MessagesSidePane.tsx`、`useImSidebar.ts` 与 `useImNotifications.ts`。
侧栏宿主传入既有 tab；相同 workspace 复用消息 tab，切换任务保持可见，不同 workspace 不混用。
通知和角标由服务视图派生，不建立另一份消息队列或宿主连接。

`contract.example.ts` 演示宿主传参；`contract.test.ts` 验证应用级可见性与 workspace 隔离。
服务命令、鉴权和消息协议继续使用 services/shared 的公开接口。
