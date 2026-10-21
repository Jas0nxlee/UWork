import { useEffect, useMemo, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImDirectoryUser } from "@zcode/shared";
import { FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * 写汇报：三段（内容 / 产出 / 问题）+ 收件人 + 附件，两个动作——**汇报**或**暂存**。
 *
 * 两条口径：
 * - **草稿先落本地**（`localStorage`，按人+周期存）：暂存必须立刻可用，不能依赖网络；
 *   代价是换机器看不到（界面上要写清），文件版草稿是后续（需要宿主写文件的能力）。
 * - **汇报是"云端落库 + 投递"一件事**：`submitReport` 一步做完，客户端不再单独发消息，
 *   否则会出现"库里有一份、IM 里没有"或反过来的分裂。
 */
const draftKey = (userId: string | null, periodKey: string): string =>
  `uwork:im-report-draft:${userId ?? "anon"}:${periodKey}`;

export interface ReportDraft {
  periodKey: string;
  title: string;
  summary: string;
  content: string;
  problems: string;
  recipientId: string;
}

/** ISO 周：`2026-W42`。按本地日期算，避免"周一交的算上周"。 */
export function currentPeriodKey(now = new Date()): string {
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function ImReportComposeDialog({
  service,
  selfUserId,
  directory,
  onClose,
  onSubmitted,
}: {
  service: IImService | null;
  selfUserId: string | null;
  directory: ImDirectoryUser[];
  onClose: () => void;
  /** 提交成功后回调：外层收起弹窗、刷新列表、切到与收件人的会话。 */
  onSubmitted: (input: { conversationId: string; recipientId: string }) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);
  const periodKey = useMemo(() => currentPeriodKey(), []);
  const [draft, setDraft] = useState<ReportDraft>({
    periodKey,
    title: "",
    summary: "",
    content: "",
    problems: "",
    recipientId: "",
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 打开时恢复上次暂存的草稿（暂存的意义就在这）。
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(draftKey(selfUserId, periodKey));
    if (!raw) return;
    try {
      setDraft((current) => ({ ...current, ...(JSON.parse(raw) as Partial<ReportDraft>) }));
    } catch {
      // 坏草稿直接忽略，不挡住"写新的"
    }
  }, [selfUserId, periodKey]);

  const recipients = directory.filter((user) => user.id !== selfUserId);
  const update = (patch: Partial<ReportDraft>): void =>
    setDraft((current) => ({ ...current, ...patch }));

  const saveLocal = (): void => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(draftKey(selfUserId, periodKey), JSON.stringify({ ...draft, periodKey }));
  };

  const submit = async (): Promise<void> => {
    if (!service) return;
    if (!draft.title.trim()) {
      setError(t("im.reportTitleRequired"));
      return;
    }
    if (!draft.recipientId) {
      setError(t("im.reportRecipientRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const { report, message } = await service.submitReport({
        periodKey,
        title: draft.title,
        summary: draft.summary,
        content: draft.content,
        problems: draft.problems,
        recipientIds: [draft.recipientId],
      });
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(draftKey(selfUserId, periodKey));
      }
      setStatus(t("im.reportSubmitted", { id: report.id.slice(0, 8) }));
      onSubmitted({ conversationId: message.conversationId, recipientId: draft.recipientId });
    } catch (caught) {
      logger.warn("[im] 提交汇报失败", caught);
      setError(t("im.reportSubmitFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="im-report-compose"
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-xl flex-col overflow-y-auto rounded-xl border border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部：标题 + 周期（周期是这张卡的身份，放右上角 chip） */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <FileTextIcon className="size-4 shrink-0 text-foreground-subtle" />
          <span className="min-w-0 flex-1 text-ui-base font-medium text-foreground">
            {t("im.reportCompose")}
          </span>
          <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-ui-2xs text-foreground-subtle tabular-nums">
            {periodKey}
          </span>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="flex flex-col gap-1">
            <span className="text-ui-2xs font-medium text-foreground-subtle">
              {t("im.reportRecipientLabel")}
            </span>
            <select
              data-testid="im-report-recipient"
              className="h-8 rounded-lg border border-border bg-surface/60 px-2 text-ui-sm text-foreground outline-none focus:border-border-hover"
              value={draft.recipientId}
              onChange={(event) => update({ recipientId: event.target.value })}
            >
              <option value="">{t("im.reportPickRecipient")}</option>
              {recipients.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-ui-2xs font-medium text-foreground-subtle">
              {t("im.reportTitleLabel")}
            </span>
            <Input
              className="h-8"
              placeholder={t("im.reportTitlePlaceholder")}
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </label>

          {/* 三段就是卡片上的分区顺序：做了什么 → 详细内容 → 遇到的问题（写的时候就按卡片看的样子排） */}
          {(
            [
              ["summary", t("im.reportSummary"), t("im.reportSummaryPlaceholder"), 2],
              ["content", t("im.reportContent"), t("im.reportContentPlaceholder"), 4],
              ["problems", t("im.reportProblems"), t("im.reportProblemsPlaceholder"), 2],
            ] as const
          ).map(([field, label, placeholder, rows]) => (
            <label key={field} className="flex flex-col gap-1">
              <span
                className={cn(
                  "text-ui-2xs font-medium",
                  field === "problems" ? "text-destructive" : "text-foreground-subtle",
                )}
              >
                {label}
              </span>
              <Textarea
                className={cn("resize-none", field === "content" ? "min-h-24" : "min-h-16")}
                rows={rows}
                placeholder={placeholder}
                value={draft[field]}
                onChange={(event) => update({ [field]: event.target.value })}
              />
            </label>
          ))}

          <p className="text-ui-2xs text-foreground-subtle">{t("im.reportDraftHint")}</p>
          {error ? <p className="text-ui-2xs text-destructive">{error}</p> : null}
          {status ? <p className="text-ui-2xs text-foreground-subtle">{status}</p> : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button
            size="sm"
            variant="ghost"
            data-testid="im-report-save-draft"
            onClick={() => {
              saveLocal();
              setStatus(t("im.reportDraftSaved"));
            }}
          >
            {t("im.reportSaveDraft")}
          </Button>
          <Button
            size="sm"
            data-testid="im-report-submit"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? t("im.reportSubmitting") : t("im.reportSubmit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
