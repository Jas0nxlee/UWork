import type { MessagesSidePaneTab } from "@/lib/workspaceSidePane.js";

/** 消息面板只接收既有侧栏 tab；消息与未读的事实由宿主 IImService 所有。 */
export interface MessagesSidePaneProps {
  tab: MessagesSidePaneTab;
}

// UI 只依赖服务的公开类型；运行时实例仍由 workspace service hook 注入。
export type { IImService, ImView, ImRealtimeEvent } from "@zcode/services";
