import { useState } from "react";
import type { IImService } from "./contract.js";
import { UndoIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * 「退回」的意见弹窗。
 *
 * 为什么退回必须走弹窗、而「已阅」直接执行：退回的**意见是必填**的（服务端也强校验），
 * 作者据此才知道改什么；已阅是最短动作，多一次确认等于给最常见的操作加摩擦（见 §12.18 的取舍）。
 *
 * 失败时**显示服务端原文**（例如"只有审核人能回执"），不翻译成模糊话术——那句话本身就是答案。
 */
export function ImCardReturnDialog({
  service,
  itemId,
  title,
  onClose,
}: {
  service: IImService | null;
  itemId: string;
  title: string;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!service) {
      setError(t("im.cardActionUnavailable"));
      return;
    }
    if (!comment.trim()) {
      setError(t("im.cardReturnCommentRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await service.reviewWorkItem({ itemId, status: "returned", comment: comment.trim() });
      onClose();
    } catch (caught) {
      logger.warn("[im] 退回失败", caught);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="im-card-return"
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-lg flex-col rounded-xl border border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <UndoIcon className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
            {t("im.cardReturnTitle", { title })}
          </span>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3">
          <span className="text-ui-2xs font-medium text-foreground-subtle">
            {t("im.cardReturnCommentLabel")}
          </span>
          <Textarea
            data-testid="im-card-return-comment"
            className="min-h-24 resize-none"
            rows={4}
            placeholder={t("im.cardReturnCommentPlaceholder")}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <p className="text-ui-2xs text-foreground-subtle">{t("im.cardReturnHint")}</p>
          {error ? (
            <p role="alert" className="text-ui-2xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            {t("im.cardReturnCancel")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            data-testid="im-card-return-submit"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? t("im.cardActionPending") : t("im.cardReturnSubmit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
