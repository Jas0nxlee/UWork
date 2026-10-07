import type { UcasGatewayView } from "@zcode/shared";
import { Cpu, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Progress } from "@/components/ui/progress.js";
import { Separator } from "@/components/ui/separator.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SegmentPill } from "@/settings/PluginStoreListView.js";
import type { UcasGatewayController } from "@/hooks/useUcasGateway.js";
import {
  formatCount,
  formatPercentValue,
  formatTokens,
  formatUsd,
  shortModelName,
} from "./gatewayFormat.js";
import { InfoTile, METRICS, PERIODS, SectionCard, type Translate } from "./gatewayUiParts.js";

export function UsageSection({
  gateway,
  t,
  view,
}: {
  gateway: UcasGatewayController;
  t: Translate;
  view: UcasGatewayView;
}) {
  const { locale } = useZCodeIntl();
  const usage = view.usage;
  return (
    <SectionCard icon={<Cpu className="size-4" aria-hidden="true" />} title={t("usage.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((period) => (
            <SegmentPill
              key={period}
              active={gateway.period === period}
              label={t(`usage.period.${period}`)}
              testId={`ucas-gateway-period-${period}`}
              onClick={() => gateway.setPeriod(period)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {METRICS.map((metric) => (
            <SegmentPill
              key={metric}
              active={gateway.metric === metric}
              label={t(`usage.metric.${metric}`)}
              testId={`ucas-gateway-metric-${metric}`}
              onClick={() => gateway.setMetric(metric)}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={gateway.busy}
            onClick={() => void gateway.refreshUsage(true)}
            data-testid="ucas-gateway-refresh-usage"
          >
            <RefreshCw
              className={cn("size-3", gateway.busy && "animate-spin")}
              aria-hidden="true"
            />
            {t("usage.refresh")}
          </Button>
        </div>
      </div>
      <Separator />
      {!usage ? (
        <p className="text-ui-sm text-foreground-subtle">{t("usage.empty")}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <InfoTile
              label={t("usage.requests")}
              value={formatCount(locale, usage.summary.requestCount)}
            />
            <InfoTile
              label={t("usage.successRate")}
              value={formatPercentValue(locale, usage.summary.successRate)}
            />
            <InfoTile label={t("usage.cost")} value={formatUsd(locale, usage.summary.cost)} />
            <InfoTile
              label={t("usage.tokens")}
              value={formatTokens(locale, usage.summary.totalTokens)}
            />
          </div>
          <UsageTrend gateway={gateway} locale={locale} t={t} view={view} />
          <ModelBreakdown locale={locale} t={t} usage={usage} />
        </>
      )}
    </SectionCard>
  );
}

function UsageTrend({
  gateway,
  locale,
  t,
  view,
}: {
  gateway: UcasGatewayController;
  locale: string;
  t: Translate;
  view: UcasGatewayView;
}) {
  const trend = view.usage?.trend ?? [];
  if (trend.length === 0) return null;
  const value = (point: (typeof trend)[number]) =>
    gateway.metric === "cost"
      ? point.cost
      : gateway.metric === "tokens"
        ? point.tokens
        : point.requestCount;
  const max = Math.max(...trend.map(value), 0);
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-surface/50 px-3 py-2.5">
      <div className="text-ui-sm text-foreground-subtle">{t("usage.trend")}</div>
      {/* 等分填充：无论 5 根还是 30 根，柱子都平分整行宽度、间隙固定，既不居中成簇也不被拉散。 */}
      <div className="flex h-20 items-end gap-1 border-b border-border/50 pb-0.5">
        {trend.map((point) => (
          <div
            key={point.date}
            title={`${point.date} · ${formatCount(locale, point.requestCount)}`}
            className="min-w-0 flex-1 rounded-md bg-gradient-to-t from-primary/35 to-primary/75"
            style={{ height: `${max > 0 ? Math.max(4, (value(point) / max) * 100) : 4}%` }}
          />
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border/50 pt-1.5 text-ui-xs text-foreground-subtlest">
        <span>{trend[0]?.date}</span>
        <span>{trend[trend.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function ModelBreakdown({
  locale,
  t,
  usage,
}: {
  locale: string;
  t: Translate;
  usage: NonNullable<UcasGatewayView["usage"]>;
}) {
  if (usage.models.length === 0) return null;
  const max = Math.max(...usage.models.map((model) => model.requestCount), 0);
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-surface/50 px-3 py-2.5">
      <div className="text-ui-sm text-foreground-subtle">{t("usage.models")}</div>
      {usage.models.slice(0, 8).map((model) => (
        <div
          key={model.model}
          className="space-y-1 border-b border-border/40 pb-1.5 last:border-b-0 last:pb-0"
        >
          <div className="flex items-center justify-between gap-2 text-ui-sm">
            <span className="truncate font-mono text-foreground">
              {shortModelName(model.model)}
            </span>
            <span className="shrink-0 text-foreground-subtle">
              {t("usage.modelRow", {
                requests: formatCount(locale, model.requestCount),
                cost: formatUsd(locale, model.cost),
              })}
            </span>
          </div>
          <Progress value={max > 0 ? (model.requestCount / max) * 100 : 0} />
        </div>
      ))}
    </div>
  );
}
