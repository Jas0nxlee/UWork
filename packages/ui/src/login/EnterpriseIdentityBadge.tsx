import { ChevronDown, RefreshCw, UserRound } from "lucide-react";
import { useEnterpriseIdentity } from "@/hooks/useEnterpriseIdentity.js";
import { useUcasGateway } from "@/hooks/useUcasGateway.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsUsageEnterpriseIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu.js";

export function EnterpriseIdentityBadge() {
  const identity = useEnterpriseIdentity();
  const gateway = useUcasGateway();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const { intl } = useZCodeIntl();
  if (!identity) return null;
  const t = (id: string) => intl.formatMessage({ id: `enterpriseIdentity.${id}` });
  const profile = identity.view?.status === "authenticated" ? identity.view.profile : null;
  const gatewayUser = gateway.view?.user ?? null;
  // 公司名来自回包的组织（tenantId）在配置清单里的展示名，不用本地选择值冒充。
  const companyName = profile ? identity.organizationLabel(profile.tenantId) : null;
  const subtitle = [gatewayUser?.department, gatewayUser?.position].filter(Boolean).join(" · ");
  const className =
    "flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-ui-sm text-foreground-subtle hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  if (!profile) {
    return identity.allowLogin ? (
      <button
        type="button"
        className={className}
        onClick={identity.openLogin}
        data-testid="enterprise-identity-entry"
      >
        <UserRound className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{t("signedOut")}</span>
      </button>
    ) : null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={className}
          title={companyName ? `${profile.displayName} · ${companyName}` : profile.displayName}
          data-testid="enterprise-identity-name"
        >
          <UserRound className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{profile.displayName}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{profile.displayName}</DropdownMenuLabel>
        {companyName ? (
          <DropdownMenuLabel
            className="text-ui-sm text-foreground-subtle"
            data-testid="enterprise-identity-company"
          >
            {companyName}
          </DropdownMenuLabel>
        ) : null}
        {subtitle ? (
          <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
            {subtitle}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
          {t("source")}
        </DropdownMenuLabel>
        {identity.allowLogin ? (
          <>
            <DropdownMenuSeparator />
            {gateway.available ? (
              <DropdownMenuItem
                onSelect={() => void gateway.sync()}
                data-testid="enterprise-identity-sync-gateway"
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {t("syncGateway")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={() => {
                setPendingSettingsUsageEnterpriseIntent();
                openSettingsTab();
              }}
              data-testid="enterprise-identity-open-gateway"
            >
              {t("gateway")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void identity.logout()}>
              {t("logout")}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
