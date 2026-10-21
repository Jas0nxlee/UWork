import { memo } from "react";
import type { ImConversationSummary, ImDirectoryUser } from "@zcode/shared";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { avatarTone, conversationTitle, initialsOf } from "./imPresentation.js";

/**
 * 转发：选一个会话把同一条正文发过去。
 *
 * 只列**自己已经在的会话**（服务端会再校验一次成员资格），不提供"搜索任何人"——
 * 转发是"发到我知道的地方"，不是"发给任意人"，后者是发起新会话（另有一个入口）。
 */
export const ImForwardDialog = memo(function ImForwardDialog({
  conversations,
  directory,
  selfUserId,
  preview,
  onPick,
  onClose,
}: {
  conversations: ImConversationSummary[];
  directory: ImDirectoryUser[];
  selfUserId: string | null;
  preview: string;
  onPick: (conversationId: string) => void;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });
  const nameById = new Map(directory.map((user) => [user.id, user]));

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 p-4">
      <div className="flex max-h-full w-full max-w-sm flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="text-ui-sm font-medium">{t("im.forwardTitle")}</span>
          <Button
            className="ml-auto size-6 shrink-0 p-0"
            variant="ghost"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </header>
        <p className="shrink-0 border-b border-border px-4 py-2 text-ui-2xs text-muted-foreground">
          <span className="line-clamp-2">{preview}</span>
        </p>
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {conversations.length === 0 ? (
            <li className="px-4 py-6 text-center text-ui-xs text-muted-foreground">
              {t("im.forwardNoTarget")}
            </li>
          ) : (
            conversations.map((conversation) => {
              const title = conversationTitle(
                conversation,
                selfUserId,
                (id) => nameById.get(id)?.name ?? undefined,
                t("im.untitled"),
              );
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    data-testid="im-forward-target"
                    className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent"
                    onClick={() => onPick(conversation.id)}
                  >
                    <span
                      className={
                        "flex size-8 shrink-0 items-center justify-center rounded-lg text-ui-2xs font-medium " +
                        avatarTone(conversation.id)
                      }
                    >
                      {initialsOf(title)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ui-sm">{title}</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
});
