import { memo, useMemo, useState } from "react";
import type { ImDirectoryUser } from "@zcode/shared";
import { UserRoundIcon } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  IM_CHROME,
  IM_EMPTY,
  IM_EMPTY_ICON,
  IM_EMPTY_TEXT,
  IM_HEADER,
  IM_HEADER_TITLE,
  IM_LIST_NAME,
  IM_LIST_PADDING,
  IM_LIST_PREVIEW,
  IM_LIST_ROW,
  IM_LIST_ROW_IDLE,
  IM_SEARCH_INPUT,
} from "./imChrome.js";
import { avatarTone, initialsOf } from "./imPresentation.js";

/**
 * 通讯录（rail 的第二个入口）：把同事列成可点的一列，点谁就开跟谁的单聊。
 *
 * 和"发起单聊"那个选择器（`ImDirectoryPicker`）的区别是定位：这里是**浏览**（列表常驻、
 * 只有一个搜索框、没有建群那种新建动作），那里是**新建流程**（有模式切换、要有取消）。
 * 之前两个入口共用同一个组件，结果界面上出现两个搜索框、两套标题——不协调就是这么来的。
 */
export const ImDirectoryList = memo(function ImDirectoryList({
  users,
  onPick,
}: {
  users: ImDirectoryUser[];
  onPick: (user: ImDirectoryUser) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim();
    if (!needle) return users;
    return users.filter(
      (user) => (user.name ?? "").includes(needle) || (user.department ?? "").includes(needle),
    );
  }, [users, query]);

  return (
    <div className={cn("flex w-60 shrink-0 flex-col border-r border-border", IM_CHROME)}>
      <header className={IM_HEADER}>
        <span className={IM_HEADER_TITLE}>{t("im.directory")}</span>
        <span className="ml-auto text-ui-2xs text-foreground-subtle">
          {t("im.memberCount", { count: filtered.length })}
        </span>
      </header>
      <div className="shrink-0 px-3 pt-2 pb-1">
        <Input
          className={IM_SEARCH_INPUT}
          placeholder={t("im.searchPeople")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ul className={cn("min-h-0 flex-1 overflow-y-auto py-1", IM_LIST_PADDING)}>
        {filtered.length === 0 ? (
          <li className={cn(IM_EMPTY, "py-10")}>
            <UserRoundIcon className={IM_EMPTY_ICON} />
            <span className={IM_EMPTY_TEXT}>{t("im.noDirectory")}</span>
          </li>
        ) : (
          filtered.map((user) => {
            const name = user.name ?? user.id;
            return (
              <li key={user.id}>
                <button
                  type="button"
                  data-testid="im-directory-row"
                  className={cn(IM_LIST_ROW, IM_LIST_ROW_IDLE)}
                  onClick={() => onPick(user)}
                >
                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full text-ui-2xs font-medium",
                      avatarTone(user.id),
                    )}
                  >
                    {initialsOf(name)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={IM_LIST_NAME}>{name}</span>
                    {user.department ? (
                      <span className={IM_LIST_PREVIEW}>{user.department}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
});
