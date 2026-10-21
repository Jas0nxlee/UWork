import { memo, useMemo, useState } from "react";
import type { ImDirectoryUser } from "@zcode/shared";
import { ChevronRightIcon, UserRoundIcon } from "lucide-react";
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
  IM_LIST_GROUP_LABEL,
  IM_LIST_NAME,
  IM_LIST_PADDING,
  IM_LIST_PREVIEW,
  IM_LIST_ROW,
  IM_LIST_ROW_IDLE,
  IM_SEARCH_INPUT,
} from "./imChrome.js";
import { avatarTone, groupDirectoryByDepartment, initialsOf } from "./imPresentation.js";

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
  /**
   * 折叠的部门（key 集合）。跟着人走：企业通讯录里"我常找的部门"是稳定偏好，
   * 每次进来都全展开等于每次都要收一遍。
   * 搜索时**强制展开**——否则会出现"人明明搜到了、却藏在折叠栏里"，那比不能折叠更糟。
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsed());

  const toggleGroup = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeCollapsed(next);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const needle = query.trim();
    if (!needle) return users;
    // 搜索要匹配**任意**一个部门（有人在多个部门时，按主部门分栏、但搜哪个部门都该找得到）
    return users.filter(
      (user) =>
        (user.name ?? "").includes(needle) ||
        user.departments.some((department) => department.includes(needle)) ||
        (user.department ?? "").includes(needle),
    );
  }, [users, query]);

  const searching = query.trim().length > 0;
  const groups = useMemo(
    () => groupDirectoryByDepartment(filtered, t("im.departmentUnknown")),
    [filtered, t],
  );

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
          groups.flatMap((group) => {
            const collapsedNow = searching ? false : collapsed.has(group.key);
            return [
              <li key={`section-${group.key}`} data-testid="im-directory-group">
                <button
                  type="button"
                  data-testid="im-directory-group-toggle"
                  data-collapsed={collapsedNow ? "true" : "false"}
                  aria-expanded={!collapsedNow}
                  className={cn(
                    IM_LIST_GROUP_LABEL,
                    "flex w-full items-center gap-1 transition-colors hover:text-foreground",
                  )}
                  onClick={() => toggleGroup(group.key)}
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3 shrink-0 transition-transform",
                      collapsedNow ? "" : "rotate-90",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{group.title}</span>
                  <span className="shrink-0 tabular-nums opacity-70">{group.members.length}</span>
                </button>
              </li>,
              ...(collapsedNow
                ? []
                : group.members.map((user) => {
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
                            {/* 栏头已写部门，行里显示职位；没有职位时退回部门全串 */}
                            {(user.position ?? user.department) ? (
                              <span className={IM_LIST_PREVIEW}>
                                {user.position ?? user.department}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })),
            ];
          })
        )}
      </ul>
    </div>
  );
});

/** 折叠偏好：坏数据、无 localStorage（jsdom、隐私模式）一律当"全展开"，不打断渲染。 */
const COLLAPSED_KEY = "uwork:im-directory-collapsed";

function readCollapsed(): ReadonlySet<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeCollapsed(keys: ReadonlySet<string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // 存不下就算了：折叠是偏好，不是数据。
  }
}
