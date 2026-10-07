import { RefreshCw } from "lucide-react";
import type { UcasGatewayView } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { UsageEmptyState } from "@/settings/usage-stats/usageStatsUiParts.js";
import { useUcasGateway, type UcasGatewayController } from "@/hooks/useUcasGateway.js";
import { formatSyncTime } from "./gatewayFormat.js";
import { AccountCard, GatewayCard, ModelsSection, PlanSection } from "./GatewayCards.js";
import { UsageSection } from "./GatewayUsageSection.js";
import { ERROR_IDS, type Translate } from "./gatewayUiParts.js";

/** 企业网关面板：账号、网关配置、套餐与用量只读展示，写入动作显式触发。 */
export function UcasGatewayPanel() {
  const gateway = useUcasGateway();
  const { intl } = useZCodeIntl();
  const t: Translate = (id, values) =>
    intl.formatMessage({ id: `settings.usage.gateway.${id}` }, values);

  if (!gateway.available) {
    return (
      <UsageEmptyState title={t("unavailable.title")} description={t("unavailable.description")} />
    );
  }
  const view = gateway.view;
  if (!view) {
    return (
      <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
        <Spinner />
        {t("loading")}
      </div>
    );
  }
  if (view.status === "signed-out") {
    return (
      <div className="space-y-6" data-testid="ucas-gateway-panel">
        <GatewayHeader gateway={gateway} t={t} view={view} />
        <UsageEmptyState title={t("signedOut.title")} description={t("signedOut.description")} />
      </div>
    );
  }
  return (
    <div className="space-y-6" data-testid="ucas-gateway-panel">
      <GatewayHeader gateway={gateway} t={t} view={view} />
      {view.error ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {t(ERROR_IDS[view.error])}
        </p>
      ) : null}
      <AccountCard t={t} view={view} />
      <GatewayCard gateway={gateway} t={t} view={view} />
      <PlanSection t={t} view={view} />
      <UsageSection gateway={gateway} t={t} view={view} />
      <ModelsSection gateway={gateway} t={t} view={view} />
    </div>
  );
}

function GatewayHeader({
  gateway,
  t,
  view,
}: {
  gateway: UcasGatewayController;
  t: Translate;
  view: UcasGatewayView;
}) {
  const { locale } = useZCodeIntl();
  const authenticated = view.status !== "signed-out";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-ui-base font-medium text-foreground">{t("title")}</span>
        <Badge variant={view.status === "error" ? "destructive" : "outline"}>
          {view.status === "ready"
            ? t("status.ready")
            : view.status === "syncing"
              ? t("status.syncing")
              : view.status === "error"
                ? t("status.error")
                : t("status.idle")}
        </Badge>
        <span className="truncate text-ui-sm text-foreground-subtle">
          {view.lastSyncedAt
            ? t("lastSynced", { time: formatSyncTime(locale, view.lastSyncedAt) })
            : t("neverSynced")}
        </span>
      </div>
      {authenticated ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={gateway.busy}
          onClick={() => void gateway.sync()}
          data-testid="ucas-gateway-sync"
        >
          <RefreshCw className={cn("size-3", gateway.busy && "animate-spin")} aria-hidden="true" />
          {gateway.busy ? t("syncing") : t("sync")}
        </Button>
      ) : null}
    </div>
  );
}
