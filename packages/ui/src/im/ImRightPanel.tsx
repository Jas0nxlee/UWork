import { memo } from "react";
import type { IImService } from "@zcode/services";
import type { ImConversationSummary, ImDirectoryUser, ImMember, ImMessage } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ImGroupSettings } from "./ImGroupSettings.js";
import { ImMemberPanel } from "./ImMemberPanel.js";
import { ImPinnedPanel } from "./ImPinnedPanel.js";

/**
 * 消息列的右栏：置顶列表 / 群设置 / 成员面板三选一。
 *
 * 抽出来的理由和左栏一样——**面板本身只该管布局与状态编排**，右栏这坨有三套内容与各自的入口，
 * 留在主文件里会把"会话与消息"这条主线淹掉（也让主文件顶到 400 行门禁）。
 */
export const ImRightPanel = memo(function ImRightPanel({
  active,
  open,
  compact,
  mode,
  onModeChange,
  showPinned,
  pinned,
  service,
  directory,
  members,
  selfUserId,
  nameOf,
  onOpenPinned,
  onShowPinned,
  onClose,
  onChanged,
}: {
  active: ImConversationSummary | null;
  open: boolean;
  /** 面板窄到装不下三栏：右栏变浮层盖在消息列上。 */
  compact: boolean;
  mode: "members" | "settings";
  onModeChange: (mode: "members" | "settings") => void;
  showPinned: boolean;
  pinned: ImMessage[];
  service: IImService | null;
  directory: ImDirectoryUser[];
  members: ImMember[];
  selfUserId: string | null;
  nameOf: (id: string) => string | undefined;
  onOpenPinned: (message: ImMessage) => void;
  onShowPinned: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  if (!active || !open) return null;

  return (
    <div
      className={cn(
        "w-64 border-l border-border",
        compact ? "absolute inset-y-0 right-0 z-20 shadow-xl" : "relative shrink-0",
      )}
    >
      {showPinned ? (
        <ImPinnedPanel
          pinned={pinned}
          senderNameOf={nameOf}
          selfUserId={selfUserId}
          onOpen={onOpenPinned}
        />
      ) : mode === "settings" && active.kind !== "dm" ? (
        <ImGroupSettings
          service={service}
          conversation={active}
          directory={directory}
          selfUserId={selfUserId}
          onClose={() => onModeChange("members")}
          onChanged={onChanged}
        />
      ) : (
        <ImMemberPanel
          members={members}
          directory={directory}
          selfUserId={selfUserId}
          onOpenSettings={active.kind === "dm" ? undefined : () => onModeChange("settings")}
          onShowPinned={onShowPinned}
          pinnedCount={pinned.length}
          onClose={onClose}
        />
      )}
    </div>
  );
});
