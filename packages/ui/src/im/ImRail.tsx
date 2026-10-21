import { memo } from "react";
import { BookmarkIcon, ContactIcon, FileTextIcon, MessagesSquareIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { IM_RAIL, IM_RAIL_INDICATOR, IM_RAIL_ITEM, IM_RAIL_ITEM_ACTIVE } from "./imChrome.js";
import { avatarTone, initialsOf } from "./imPresentation.js";

/**
 * 第一栏（rail）：应用级入口。
 *
 * 最窄的一列，所以每一项都必须有真实去处，不然就是装饰；底部放"我现在以谁的身份在说话"。
 * 未读角标放在"消息"这一项上——它和侧栏入口的角标是同一个数（排静音的会话）。
 */
export const ImRail = memo(function ImRail({
  view,
  unreadTotal,
  selfName,
  onSelect,
}: {
  view: "messages" | "directory" | "bookmarks" | "reports";
  unreadTotal: number;
  selfName: string;
  onSelect: (view: "messages" | "directory" | "bookmarks" | "reports") => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });

  return (
    <nav aria-label={t("im.railLabel")} className={IM_RAIL}>
      <RailItem
        label={t("im.title")}
        active={view === "messages"}
        badge={unreadTotal}
        onClick={() => onSelect("messages")}
      >
        <MessagesSquareIcon className="size-4.5" />
      </RailItem>
      <RailItem
        label={t("im.directory")}
        active={view === "directory"}
        onClick={() => onSelect("directory")}
      >
        <ContactIcon className="size-4.5" />
      </RailItem>
      <RailItem
        label={t("im.bookmarks")}
        active={view === "bookmarks"}
        onClick={() => onSelect("bookmarks")}
      >
        <BookmarkIcon className="size-4.5" />
      </RailItem>
      <RailItem
        label={t("im.reportsTitle")}
        active={view === "reports"}
        onClick={() => onSelect("reports")}
      >
        <FileTextIcon className="size-4.5" />
      </RailItem>
      <div className="mt-auto flex flex-col items-center gap-2">
        <span
          title={selfName}
          className={cn(
            "flex size-8 items-center justify-center rounded-full text-ui-2xs font-medium",
            avatarTone(selfName),
          )}
        >
          {initialsOf(selfName)}
        </span>
      </div>
    </nav>
  );
});

/** rail 上的一个入口：36px 图标按钮，选中 = 填充 + 左侧指示条（蓝色留给未读）。 */
function RailItem({
  label,
  active,
  badge,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid="im-rail-item"
      aria-label={label}
      aria-pressed={active === true}
      title={label}
      className={cn(IM_RAIL_ITEM, active && IM_RAIL_ITEM_ACTIVE)}
      onClick={onClick}
    >
      {children}
      {active ? <span className={IM_RAIL_INDICATOR} /> : null}
      {badge && badge > 0 ? (
        <span
          data-testid="im-rail-badge"
          className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground"
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}
