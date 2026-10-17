import { memo, useEffect, useMemo, useState } from "react";
import type { ImConversationSummary, ImDirectoryUser } from "@zcode/shared";
import { MessagesSquareIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import type { MessagesSidePaneTab } from "@/lib/workspaceSidePane.js";
import { ImConversationPanel } from "./ImConversationPanel.js";
import { ImDirectoryPicker, type ImPickerMode } from "./ImDirectoryPicker.js";
import { ImGroupSettings } from "./ImGroupSettings.js";
import { useIm } from "./useIm.js";

/**
 * IM 侧边面板：左列会话、右侧消息。
 *
 * 这里只做展示与交互编排——准入由服务端的白名单决定（`entitlement.enabled === false`
 * 才隐藏内容），未连接、暂不可用等状态区分显示，不要把"查不到"当成"没权限"。
 */
export const MessagesSidePane = memo(function MessagesSidePane({
  tab,
}: {
  tab: MessagesSidePaneTab;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });
  const im = useIm();
  const [selected, setSelected] = useState<string | null>(tab.conversationId ?? null);
  const [directory, setDirectory] = useState<ImDirectoryUser[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickerMode, setPickerMode] = useState<ImPickerMode>("dm");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // DM 的标题要从 dmKey 里认出对方（服务端存的是排序后的两个成员 id），名字取自通讯录。
  // 通讯录规模很小（一期 14 人），进面板拉一次就够。
  useEffect(() => {
    if (!im.service) return;
    let active = true;
    void im.service
      .searchDirectory("")
      .then((users) => {
        if (active) setDirectory(users);
      })
      .catch((error: unknown) => {
        logger.warn("[im] 读取通讯录失败", error);
      });
    return () => {
      active = false;
    };
  }, [im.service]);

  const nameById = useMemo(() => new Map(directory.map((user) => [user.id, user])), [directory]);
  const selfUserId = im.view?.selfUserId ?? null;

  const titleOf = (summary: ImConversationSummary): string => {
    if (summary.title) return summary.title;
    if (summary.kind === "dm" && summary.dmKey) {
      const peer = summary.dmKey.split(":").find((id) => id !== selfUserId);
      const user = peer ? nameById.get(peer) : undefined;
      return user?.name ?? peer ?? t("im.untitled");
    }
    return t("im.untitled");
  };

  const subtitleOf = (summary: ImConversationSummary): string => {
    if (summary.kind !== "dm" || !summary.dmKey) return "";
    const peer = summary.dmKey.split(":").find((id) => id !== selfUserId);
    return (peer ? nameById.get(peer)?.department : null) ?? "";
  };

  if (!im.available) {
    return <ImNotice text={t("im.unavailableInHost")} />;
  }
  if (!im.loaded) {
    return <ImNotice text={t("im.loading")} />;
  }
  const entitlement = im.view?.entitlement ?? null;
  if (entitlement && !entitlement.enabled) {
    return <ImNotice text={t("im.notInAllowlist")} />;
  }

  const conversations = im.view?.conversations ?? [];
  const active = conversations.find((conversation) => conversation.id === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <MessagesSquareIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t("im.title")}</span>
        <ConnectionBadge status={im.view?.connection ?? "idle"} label={(id) => t(id)} />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setPicking((current) => !current)}
            title={t("im.newDm")}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => void im.refresh()}
            title={t("im.refresh")}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
      </header>

      {im.view?.lastError ? (
        <p className="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground">
          {im.view.lastError}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-52 shrink-0 flex-col border-r border-border">
          {picking ? (
            <ImDirectoryPicker
              users={directory}
              mode={pickerMode}
              onModeChange={setPickerMode}
              onPickDm={(user) => {
                if (!im.service) return;
                void im.service
                  .createDm(user.id)
                  .then((conversation) => {
                    setSelected(conversation.id);
                    setPicking(false);
                  })
                  .catch((error: unknown) => logger.warn("[im] 发起单聊失败", error));
              }}
              onCreateGroup={(memberIds, title) => {
                if (!im.service) return;
                void im.service
                  .createGroup({ memberIds, title: title || t("im.untitled") })
                  .then((conversation) => {
                    setSelected(conversation.id);
                    setPicking(false);
                  })
                  .catch((error: unknown) => logger.warn("[im] 建群失败", error));
              }}
              onClose={() => setPicking(false)}
            />
          ) : null}
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {conversations.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">{t("im.noConversations")}</li>
            ) : (
              conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent",
                      conversation.id === selected && "bg-accent",
                    )}
                    onClick={() => setSelected(conversation.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{titleOf(conversation)}</span>
                    {conversation.unreadCount > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                        {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="min-w-0 flex-1">
          {active && settingsOpen && active.kind !== "dm" ? (
            <ImGroupSettings
              service={im.service}
              conversation={active}
              directory={directory}
              selfUserId={selfUserId}
              onClose={() => setSettingsOpen(false)}
              onChanged={() => void im.refresh()}
            />
          ) : active ? (
            <ImConversationPanel
              service={im.service}
              conversationId={active.id}
              selfUserId={selfUserId}
              title={titleOf(active)}
              subtitle={subtitleOf(active)}
              onOpenSettings={active.kind === "dm" ? undefined : () => setSettingsOpen(true)}
            />
          ) : (
            <ImNotice text={t("im.pickConversation")} />
          )}
        </div>
      </div>
    </div>
  );
});

function ImNotice({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function ConnectionBadge({ status, label }: { status: string; label: (id: string) => string }) {
  if (status === "online") return null;
  const id =
    status === "connecting"
      ? "im.connection.connecting"
      : status === "retrying"
        ? "im.connection.retrying"
        : status === "forbidden"
          ? "im.connection.forbidden"
          : status === "unavailable"
            ? "im.connection.unavailable"
            : "im.connection.idle";
  return (
    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
      {label(id)}
    </span>
  );
}
