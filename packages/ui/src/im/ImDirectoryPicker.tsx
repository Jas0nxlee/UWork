import { memo, useMemo, useState } from "react";
import type { ImDirectoryUser } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

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
    <div className="border-b border-border p-2">
      <div className="mb-1 flex items-center gap-1">
        {(["dm", "group"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px]",
              mode === candidate
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
            onClick={() => onModeChange(candidate)}
          >
            {candidate === "dm" ? t("im.newDm") : t("im.newGroup")}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          {t("im.cancel")}
        </button>
      </div>
      <Input
        autoFocus
        className="h-7 text-xs"
        placeholder={t("im.searchPeople")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {mode === "group" ? (
        <Input
          className="mt-1 h-7 text-xs"
          placeholder={t("im.groupName")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      ) : null}
      <ul className="mt-1 max-h-40 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-1 py-1.5 text-[11px] text-muted-foreground">{t("im.noDirectory")}</li>
        ) : (
          filtered.map((user) => {
            const picked = selected.includes(user.id);
            return (
              <li key={user.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent",
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
                  <span className="min-w-0 flex-1 truncate text-xs">{user.name ?? user.id}</span>
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
          className="mt-1 h-7 w-full text-xs"
          disabled={selected.length === 0}
          onClick={() => onCreateGroup(selected, title.trim())}
        >
          {intl.formatMessage({ id: "im.createGroup" }, { count: selected.length })}
        </Button>
      ) : null}
    </div>
  );
});
