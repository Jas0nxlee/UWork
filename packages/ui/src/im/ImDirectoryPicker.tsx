import { memo, useMemo, useState } from "react";
import type { ImDirectoryUser } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { IM_LIST_NAME, IM_LIST_ROW, IM_LIST_ROW_IDLE, IM_SEARCH_INPUT } from "./imChrome.js";

export type ImPickerMode = "dm" | "group";

/**
 * 选人面板：单聊点一次即成，建群是多选 + 群名。
 * 两种模式共用一个组件——否则"选人"这件事会出现两套过滤/排序/空态，迟早不一致。
 */
export const ImDirectoryPicker = memo(function ImDirectoryPicker({
  users,
  mode,
  exclude = [],
  onModeChange,
  onPickDm,
  onCreateGroup,
  onClose,
}: {
  users: ImDirectoryUser[];
  mode: ImPickerMode;
  /** 已在会话里的人不再出现在候选（建群/拉人复用同一个面板）。 */
  exclude?: string[];
  onModeChange: (mode: ImPickerMode) => void;
  onPickDm: (user: ImDirectoryUser) => void;
  onCreateGroup: (memberIds: string[], title: string) => void;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");

  const excluded = useMemo(() => new Set(exclude), [exclude]);
  const filtered = useMemo(
    () =>
      users
        .filter((user) => !excluded.has(user.id))
        .filter(
          (user) =>
            !query || (user.name ?? "").includes(query) || (user.department ?? "").includes(query),
        ),
    [users, excluded, query],
  );

  const toggle = (id: string): void =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  return (
    <div className="border-b border-border px-3 py-2">
      <div className="mb-2 flex items-center gap-1">
        {(["dm", "group"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={cn(
              "rounded-md px-2 py-1 text-ui-2xs transition-colors",
              mode === candidate
                ? "bg-surface text-foreground"
                : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
            )}
            onClick={() => onModeChange(candidate)}
          >
            {candidate === "dm" ? t("im.newDm") : t("im.newGroup")}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto rounded-md px-2 py-1 text-ui-2xs text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
          onClick={onClose}
        >
          {t("im.cancel")}
        </button>
      </div>
      <Input
        autoFocus
        className={IM_SEARCH_INPUT}
        placeholder={t("im.searchPeople")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {mode === "group" ? (
        <Input
          className={cn(IM_SEARCH_INPUT, "mt-2")}
          placeholder={t("im.groupName")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      ) : null}
      <ul className="mt-1 max-h-40 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-2 py-3 text-ui-2xs text-foreground-subtle">{t("im.noDirectory")}</li>
        ) : (
          filtered.map((user) => {
            const picked = selected.includes(user.id);
            return (
              <li key={user.id}>
                <button
                  type="button"
                  className={cn(
                    cn(IM_LIST_ROW, IM_LIST_ROW_IDLE, "h-10"),
                    mode === "group" && picked && "bg-muted",
                  )}
                  onClick={() => (mode === "dm" ? onPickDm(user) : toggle(user.id))}
                >
                  {mode === "group" ? (
                    <span
                      className={cn(
                        "size-3 shrink-0 rounded-sm border border-border",
                        picked && "border-primary bg-primary",
                      )}
                    />
                  ) : null}
                  <span className={cn(IM_LIST_NAME, "min-w-0 flex-1")}>{user.name ?? user.id}</span>
                  <span className="max-w-[45%] truncate text-[10px] text-muted-foreground">
                    {user.department ?? ""}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
      {mode === "group" ? (
        <Button
          size="sm"
          className={cn(IM_SEARCH_INPUT, "mt-2")}
          disabled={selected.length === 0}
          onClick={() => onCreateGroup(selected, title.trim())}
        >
          {intl.formatMessage({ id: "im.createGroup" }, { count: selected.length })}
        </Button>
      ) : null}
    </div>
  );
});
