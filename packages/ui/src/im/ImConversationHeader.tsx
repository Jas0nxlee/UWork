import { memo } from "react";
import { ChevronLeftIcon, PanelRightIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { IM_HEADER, IM_HEADER_SUBTITLE, IM_HEADER_TITLE } from "./imChrome.js";
import { avatarTone, initialsOf } from "./imPresentation.js";

/** 消息列的区头：返回（单栏时）/头像/标题/副标题 + 加载更早、搜索、右栏开关。 */
export const ImConversationHeader = memo(function ImConversationHeader({
  title,
  subtitle,
  avatarSeed,
  hasMore,
  loadingOlder,
  searchOpen,
  rightPanelOpen,
  onBack,
  onLoadOlder,
  onToggleSearch,
  onToggleRightPanel,
}: {
  title: string;
  subtitle?: string;
  avatarSeed: string;
  hasMore: boolean;
  loadingOlder: boolean;
  searchOpen: boolean;
  rightPanelOpen?: boolean;
  onBack?: () => void;
  onLoadOlder: () => void;
  onToggleSearch: () => void;
  onToggleRightPanel?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });

  return (
    <header className={IM_HEADER}>
      {onBack ? (
        <Button
          className="-ml-1 size-7 shrink-0 p-0"
          variant="ghost"
          aria-label={t("im.back")}
          onClick={onBack}
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
      ) : null}
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-xl text-ui-2xs font-medium",
          avatarTone(avatarSeed),
        )}
      >
        {initialsOf(title)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn(IM_HEADER_TITLE, "truncate")}>{title}</span>
        {subtitle ? <span className={cn(IM_HEADER_SUBTITLE, "truncate")}>{subtitle}</span> : null}
      </div>
      {hasMore ? (
        <Button
          className="h-7 shrink-0 rounded-lg px-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          variant="ghost"
          disabled={loadingOlder}
          onClick={onLoadOlder}
        >
          {loadingOlder ? t("im.loading") : t("im.loadOlder")}
        </Button>
      ) : null}
      <Button
        className={cn(
          "size-7 shrink-0 rounded-lg p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
          searchOpen && "bg-surface text-foreground",
        )}
        variant="ghost"
        aria-label={t("im.searchInConversation")}
        onClick={onToggleSearch}
      >
        <SearchIcon className="size-4" />
      </Button>
      {onToggleRightPanel ? (
        <Button
          className={cn(
            "size-7 shrink-0 rounded-lg p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
            rightPanelOpen && "bg-surface text-foreground",
          )}
          variant="ghost"
          aria-label={t("im.groupSettings")}
          onClick={onToggleRightPanel}
        >
          <PanelRightIcon className="size-4" />
        </Button>
      ) : null}
    </header>
  );
});
