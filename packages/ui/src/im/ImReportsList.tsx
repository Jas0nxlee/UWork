import { useEffect, useMemo, useState } from "react";
import type { IImService } from "./contract.js";
import type { ImDirectoryUser, ImWorkReport } from "@zcode/shared";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatClockTime } from "./imPresentation.js";
import { IM_EMPTY, IM_EMPTY_TEXT, IM_LIST_ROW, IM_LIST_ROW_IDLE } from "./imChrome.js";

/**
 * 汇报记录页（rail 第四项）：**云端记录的可视面**。
 *
 * 两段列表：我提交的 / 我收到的。领导进来第一眼要能答"这周谁交了"，
 * 所以按提交时间倒序、每行给"谁 · 周期 · 标题 · 问题有没有"。
 */
export function ImReportsList({
  service,
  selfUserId,
  nameOf,
  refreshToken,
  onOpen,
  onCompose,
}: {
  service: IImService | null;
  selfUserId: string | null;
  nameOf: (id: string) => string | undefined;
  /** 外部触发刷新（例如刚提交完一份）。 */
  refreshToken?: number;
  onOpen: (reportId: string) => void;
  onCompose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);
  const [reports, setReports] = useState<ImWorkReport[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!service) return;
    let active = true;
    void service
      .listReports({ limit: 100 })
      .then((items) => {
        if (active) {
          setReports(items);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        logger.warn("[im] 读取汇报列表失败", error);
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [service, refreshToken]);

  const { mine, received } = useMemo(() => {
    const mineList: ImWorkReport[] = [];
    const receivedList: ImWorkReport[] = [];
    for (const report of reports) {
      if (report.authorId === selfUserId) mineList.push(report);
      else receivedList.push(report);
    }
    return { mine: mineList, received: receivedList };
  }, [reports, selfUserId]);

  const renderRow = (report: ImWorkReport) => (
    <button
      key={report.id}
      type="button"
      data-testid="im-report-row"
      className={`${IM_LIST_ROW} ${IM_LIST_ROW_IDLE} w-full text-left`}
      onClick={() => onOpen(report.id)}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">{report.title}</span>
          {report.problems ? (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-ui-2xs text-amber-500">
              {t("im.reportHasProblems")}
            </span>
          ) : null}
          <span
            className={
              report.status === "reviewed"
                ? "shrink-0 rounded-full bg-emerald-500/15 px-1.5 text-ui-2xs text-emerald-500"
                : "shrink-0 rounded-full bg-surface px-1.5 text-ui-2xs text-foreground-subtle"
            }
          >
            {report.status === "reviewed"
              ? t("im.reportStatusReviewed")
              : report.status === "returned"
                ? t("im.reportStatusReturned")
                : t("im.reportStatusSubmitted")}
          </span>
        </span>
        <span className="truncate text-ui-2xs text-foreground-subtle">
          {nameOf(report.authorId) ?? report.authorId} · {report.periodKey}
        </span>
      </span>
      <span className="shrink-0 text-ui-2xs text-foreground-subtle tabular-nums">
        {formatClockTime(report.submittedAt)}
      </span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-ui-sm text-foreground">{t("im.reportsTitle")}</span>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-ui-2xs" onClick={onCompose}>
          <PlusIcon className="mr-1 size-3" />
          {t("im.reportCompose")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!loaded ? (
          <p className={`${IM_EMPTY_TEXT} py-6 text-center`}>{t("im.loading")}</p>
        ) : reports.length === 0 ? (
          <div className={`${IM_EMPTY} py-10`}>
            <p className={IM_EMPTY_TEXT}>{t("im.reportsEmpty")}</p>
          </div>
        ) : (
          <>
            {received.length > 0 ? (
              <p className="px-3 pt-2 pb-1 text-ui-2xs text-foreground-subtle">
                {t("im.reportsReceived")}
              </p>
            ) : null}
            {received.map(renderRow)}
            {mine.length > 0 ? (
              <p className="px-3 pt-3 pb-1 text-ui-2xs text-foreground-subtle">
                {t("im.reportsMine")}
              </p>
            ) : null}
            {mine.map(renderRow)}
          </>
        )}
      </div>
    </div>
  );
}

/** 收件人下拉用的候选（通讯录里除自己以外的人）。 */
export function reportRecipientOptions(
  directory: ImDirectoryUser[],
  selfUserId: string | null,
): ImDirectoryUser[] {
  return directory.filter((user) => user.id !== selfUserId);
}
