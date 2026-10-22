import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { ImView, ImRealtimeEvent } from "./contracts/view.js";
import type { ImConversationCommands } from "./contracts/conversations.js";
import type { ImTimelineCommands } from "./contracts/timeline.js";
import type { ImMessageExtras } from "./contracts/extras.js";
import type { ImReportCommands } from "./contracts/reports.js";

export type {
  ImAttachment,
  ImBookmarkItem,
  ImConversation,
  ImConversationKind,
  ImConversationSummary,
  ImDirectoryUser,
  ImEntitlement,
  ImMember,
  ImMessage,
  ImWorkReport,
  ImGlobalSearchPage,
  ImMessageKind,
  ImReaction,
  ImReplyPreview,
  ImSearchPage,
  ImSystemAction,
} from "@zcode/shared";

export type {
  ImConnectionStatus,
  ImView,
  ImMessagesView,
  ImRealtimeEvent,
} from "./contracts/view.js";

/** 能力按会话、时间线、消息操作与汇报分组；继续使用同一个服务和 RPC 通道。 */
export interface IImService
  extends ImConversationCommands, ImTimelineCommands, ImMessageExtras, ImReportCommands {
  onDidChange: Event<ImView>;
  onRealtime: Event<ImRealtimeEvent>;
}
export const IImService = createServiceDescriptor<IImService>(ServiceChannels.Im);
