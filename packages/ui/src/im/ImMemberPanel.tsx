import { memo, useMemo } from "react";
import type { ImMember } from "@zcode/shared";
import type { ImDirectoryUser } from "@zcode/shared";
import { SettingsIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { IM_CHROME, IM_HEADER, IM_HEADER_TITLE, IM_LIST_PADDING } from "./imChrome.js";
import { avatarTone, initialsOf } from "./imPresentation.js";

/**
 * 右栏的成员面板（设计稿里的 `.members`）。
 *
 * 两个判断：
 * 1. **在线状态只来自服务端**。客户端拿不到别人的连接状态，凭"最近活跃时间"猜一个绿点
 *    是在造假数据——所以这里只渲染服务端给的 `online`，未知就不显示状态点。
 * 2. **按在线分组而不是按姓名排序**：成员面板的用途是"现在谁能立刻回我"，
 *    所以在线在前、离线在后，两组内部按姓名稳定排序。
 * 群设置（改名/加人/移除/退群）不在这一层展开，收进右上角的入口——设计稿里右栏就是成员，
 * 管理操作属于"点进去才看到"的东西。
 */
export const ImMemberPanel = memo(function ImMemberPanel({
  members,
  directory,
  selfUserId,
  onOpenSettings,
  onClose,
  settingsDisabled,
}: {
  members: ImMember[];
  directory: ImDirectoryUser[];
  selfUserId: string | null;
  onOpenSettings?: () => void;
  onClose?: () => void;
  settingsDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);
  const infoById = useMemo(() => new Map(directory.map((user) => [user.id, user])), [directory]);

  const label = (member: ImMember): string =>
    member.id === selfUserId ? t("im.you") : (infoById.get(member.id)?.name ?? member.id);

  const sorted = useMemo(() => {
    return [...members].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return label(a).localeCompare(label(b), "zh-Hans-CN");
    });
    // label 依赖 intl 与 directory，两者变化都要重排
  }, [members, directory, selfUserId, intl]);

  const online = sorted.filter((member) => member.online);
  const offline = sorted.filter((member) => !member.online);

  const renderGroup = (title: string, list: ImMember[]): React.ReactNode =>
    list.length === 0 ? null : (
      <div className="mt-2 first:mt-0">
        <p className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-foreground-subtle">
          {title} — {list.length}
        </p>
        <ul>
          {list.map((member) => {
            const info = infoById.get(member.id);
            return (
              <li key={member.id} data-testid="im-member-row">
                <div className="flex h-11 items-center gap-2.5 rounded-lg px-2.5 transition-colors hover:bg-surface">
                  <span className="relative shrink-0">
                    <span
                      className={cn(
                        "flex size-8 items-center justify-center rounded-full text-ui-2xs font-medium",
                        avatarTone(member.id),
                      )}
                    >
                      {initialsOf(label(member))}
                    </span>
                    {/* 状态点：只在服务端给了在线信息时才画（离线组统一不画）。 */}
                    {member.online ? (
                      <span
                        data-testid="im-member-online"
                        className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background bg-emerald-500"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-sm text-foreground">
                      {label(member)}
                      {member.role === "owner" ? (
                        <span className="ml-1.5 rounded bg-surface px-1 text-[10px] text-foreground-subtle">
                          {t("im.memberOwner")}
                        </span>
                      ) : null}
                    </span>
                    {info?.department ? (
                      <span className="block truncate text-ui-2xs text-muted-foreground">
                        {info.department}
                      </span>
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );

  return (
    <div className={cn("flex h-full min-h-0 flex-col", IM_CHROME)}>
      <header className={IM_HEADER}>
        <span className={IM_HEADER_TITLE}>{t("im.members")}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {onOpenSettings ? (
            <Button
              className="size-7 shrink-0 rounded-lg p-0 hover:bg-surface-hover hover:text-foreground"
              variant="ghost"
              aria-label={t("im.groupSettings")}
              disabled={settingsDisabled}
              onClick={onOpenSettings}
            >
              <SettingsIcon className="size-4" />
            </Button>
          ) : null}
          {onClose ? (
            <Button
              className="size-7 shrink-0 rounded-lg p-0 hover:bg-surface-hover hover:text-foreground"
              variant="ghost"
              aria-label={t("common.close")}
              onClick={onClose}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      </header>
      <div className={cn("min-h-0 flex-1 overflow-y-auto py-1", IM_LIST_PADDING)}>
        {members.length === 0 ? (
          <p className="px-4 py-6 text-center text-ui-xs text-muted-foreground">
            {t("im.loading")}
          </p>
        ) : (
          <>
            {renderGroup(t("im.membersOnline"), online)}
            {renderGroup(t("im.membersOffline"), offline)}
          </>
        )}
      </div>
    </div>
  );
});
