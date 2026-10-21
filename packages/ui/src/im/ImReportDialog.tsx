import { useEffect, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImWorkReport } from "@zcode/shared";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { IM_EMPTY_TEXT } from "./imChrome.js";

/**
 * 汇报详情：**正文只在服务端**，点开卡片时才拉。
 *
 * 为什么不在消息里带正文：长文本会污染会话预览、通知标题与全文检索；而且汇报是可修订的，
 * 消息里的快照会立刻过期——正文只有一个真相源（`GET /api/reports/:id`）。
 */
export function ImReportDialog({
  service,
  reportId,
  nameOf,
  onClose,
}: {
  service: IImService | null;
  reportId: string | null;
  nameOf: (id: string) => string | undefined;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);
  const [report, setReport] = useState<ImWorkReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!service || !reportId) return;
    let active = true;
    setReport(null);
    setError(null);
    void service
      .getReport(reportId)
      .then((value) => {
        if (active) setReport(value);
      })
      .catch((caught: unknown) => {
        logger.warn("[im] 读取汇报失败", caught);
        if (active) setError(t("im.reportLoadFailed"));
      });
    return () => {
      active = false;
    };
  }, [service, reportId, intl]);

  if (!reportId) return null;
  const statusLabel =
    report?.status === "reviewed"
      ? t("im.reportStatusReviewed")
      : report?.status === "returned"
        ? t("im.reportStatusReturned")
        : t("im.reportStatusSubmitted");

  return (
    <div
      data-testid="im-report-dialog"
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        {error ? (
          <p className="py-6 text-center text-ui-xs text-destructive">{error}</p>
        ) : !report ? (
          <p className={IM_EMPTY_TEXT}>{t("im.loading")}</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <h3 className="min-w-0 flex-1 text-ui-base font-medium text-foreground">
                {report.title}
              </h3>
              <span className="shrink-0 rounded bg-surface px-1 text-ui-2xs text-foreground-subtle tabular-nums">
                {report.periodKey}
              </span>
            </div>
            <p className="mt-0.5 text-ui-2xs text-foreground-subtle">
              {t("im.cardFrom", { name: nameOf(report.authorId) ?? report.authorId })} ·{" "}
              {statusLabel}
            </p>

            {report.summary ? (
              <section className="mt-3">
                <p className="text-ui-2xs text-foreground-subtle">{t("im.reportSummary")}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-ui-sm text-foreground">
                  {report.summary}
                </p>
              </section>
            ) : null}
            {report.content ? (
              <section className="mt-3">
                <p className="text-ui-2xs text-foreground-subtle">{t("im.reportContent")}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-ui-sm text-foreground">
                  {report.content}
                </p>
              </section>
            ) : null}
            {report.problems ? (
              <section className="mt-3 rounded-lg bg-destructive/10 p-2">
                <p className="flex items-center gap-1 text-ui-2xs text-destructive">
                  <AlertTriangleIcon className="size-3" />
                  {t("im.reportProblems")}
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-ui-sm text-foreground">
                  {report.problems}
                </p>
              </section>
            ) : null}

            {report.attachmentIds.length > 0 ? (
              <p className="mt-3 text-ui-2xs text-foreground-subtle">
                {t("im.reportAttachments", { count: report.attachmentIds.length })}
              </p>
            ) : null}

            <div className="mt-4 flex justify-end">
              <Button size="sm" variant="outline" onClick={onClose}>
                {t("common.close")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
