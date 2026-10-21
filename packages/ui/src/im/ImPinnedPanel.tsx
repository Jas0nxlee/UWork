import { memo } from "react";
import type { ImMessage } from "@zcode/shared";
import { PinIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { IM_EMPTY, IM_EMPTY_ICON, IM_EMPTY_TEXT, IM_LIST_PADDING } from "./imChrome.js";
import { avatarTone, formatClockTime, initialsOf, messageBodyText } from "./imPresentation.js";

/**
 * 右栏的置顶消息列表。
 *
 * 与成员面板共用右栏（两栏并列会太窄），点一条就跳到它在时间线里的位置——
 * 置顶的价值就是"随时能回到那句话"，只列出来不让点等于没做。
 */
export const ImPinnedPanel = memo(function ImPinnedPanel({
  pinned,
  senderNameOf,
  selfUserId,
  onOpen,
}: {
  pinned: ImMessage[];
  senderNameOf: (id: string) => string | undefined;
  selfUserId: string | null;
  onOpen: (message: ImMessage) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("min-h-0 flex-1 overflow-y-auto py-1", IM_LIST_PADDING)}>
        {pinned.length === 0 ? (
          <div className={cn(IM_EMPTY, "py-10")}>
            <PinIcon className={IM_EMPTY_ICON} />
            <p className={IM_EMPTY_TEXT}>{t("im.pinnedEmpty")}</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {pinned.map((message) => {
              const name =
                message.senderId === selfUserId
                  ? t("im.you")
                  : (senderNameOf(message.senderId) ?? message.senderId);
              return (
                <li key={message.id}>
                  <button
                    type="button"
                    data-testid="im-pinned-item"
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface"
                    onClick={() => onOpen(message)}
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-full text-ui-2xs font-medium",
                        avatarTone(message.senderId),
                      )}
                    >
                      {initialsOf(name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground">
                          {name}
                        </span>
                        <span className="shrink-0 text-ui-2xs text-foreground-subtle tabular-nums">
                          {formatClockTime(message.createdAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-ui-2xs text-foreground-subtle">
                        {messageBodyText(message, t, senderNameOf)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});
