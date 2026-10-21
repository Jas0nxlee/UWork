import { memo, useCallback, useEffect, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImConversationSummary, ImDirectoryUser } from "@zcode/shared";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ImDirectoryPicker } from "./ImDirectoryPicker.js";

/**
 * 群设置：改名、看成员、拉人、移除、退群。
 *
 * 成员列表由服务端给 id、这里用通讯录换名字——一期通讯录只有十几个人，直接查表最省事，
 * 也避免在服务端多维护一份"成员姓名"的冗余。
 */
export const ImGroupSettings = memo(function ImGroupSettings({
  service,
  conversation,
  directory,
  selfUserId,
  onClose,
  onChanged,
}: {
  service: IImService | null;
  conversation: ImConversationSummary;
  directory: ImDirectoryUser[];
  selfUserId: string | null;
  onClose: () => void;
  /** 成员/群名变化后通知外层刷新（会话列表与标题都要跟着动）。 */
  onChanged: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });
  const [members, setMembers] = useState<string[] | null>(null);
  const [title, setTitle] = useState(conversation.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  const nameOf = useCallback(
    (id: string): string =>
      id === selfUserId ? t("im.you") : (directory.find((u) => u.id === id)?.name ?? id),
    [directory, selfUserId],
  );

  const load = useCallback(async (): Promise<void> => {
    if (!service) return;
    try {
      setMembers(await service.listMembers(conversation.id));
    } catch (caught) {
      logger.warn("[im] 读取群成员失败", caught);
      setError(t("im.actionFailed"));
    }
  }, [service, conversation.id, t]);

  useEffect(() => {
    setMembers(null);
    setTitle(conversation.title ?? "");
    setError(null);
    setAdding(false);
    setConfirmingLeave(false);
    void load();
  }, [conversation.id, conversation.title, load]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
      await load();
    } catch (caught) {
      logger.warn("[im] 群设置操作失败", caught);
      setError(t("im.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const rename = (): void => {
    const next = title.trim();
    if (!next || next === conversation.title) return;
    void run(() => service!.renameConversation({ conversationId: conversation.id, title: next }));
  };

  const remove = (memberId: string): void => {
    void run(() => service!.removeMember({ conversationId: conversation.id, memberId }));
  };

  const leave = (): void => {
    if (!confirmingLeave) {
      setConfirmingLeave(true);
      return;
    }
    if (!selfUserId) return;
    void run(() =>
      service!.removeMember({ conversationId: conversation.id, memberId: selfUserId }),
    ).then(() => onClose());
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-ui-sm font-medium">{t("im.groupSettings")}</span>
        <Button
          className="ml-auto size-7 shrink-0 p-0"
          variant="ghost"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex items-center gap-2">
          <Input
            className="h-7 text-xs"
            placeholder={t("im.groupName")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            disabled={busy || !title.trim() || title.trim() === conversation.title}
            onClick={rename}
          >
            {t("im.save")}
          </Button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs font-medium">
            {t("im.members")}（{members?.length ?? "…"}）
          </span>
          <button
            type="button"
            className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setAdding((current) => !current)}
          >
            {adding ? t("im.cancel") : t("im.addMember")}
          </button>
        </div>

        {adding ? (
          <div className="-mx-2 mt-1">
            <ImDirectoryPicker
              users={directory}
              mode="group"
              exclude={members ?? []}
              onModeChange={() => undefined}
              onPickDm={() => undefined}
              onCreateGroup={(memberIds) => {
                setAdding(false);
                void run(() => service!.addMembers({ conversationId: conversation.id, memberIds }));
              }}
              onClose={() => setAdding(false)}
            />
          </div>
        ) : null}

        <ul className="mt-1 flex flex-col">
          {(members ?? []).map((memberId) => (
            <li key={memberId} className="flex items-center gap-2 border-b border-border/50 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs">{nameOf(memberId)}</span>
              {memberId === selfUserId ? (
                <span className="text-[10px] text-muted-foreground">{t("im.you")}</span>
              ) : (
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                  disabled={busy}
                  onClick={() => remove(memberId)}
                >
                  {t("im.remove")}
                </button>
              )}
            </li>
          ))}
        </ul>

        {error ? <p className="mt-2 text-[11px] text-muted-foreground">{error}</p> : null}

        <Button
          variant="ghost"
          className="mt-4 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={busy}
          onClick={leave}
        >
          {confirmingLeave ? t("im.leaveConfirm") : t("im.leave")}
        </Button>
      </div>
    </div>
  );
});
