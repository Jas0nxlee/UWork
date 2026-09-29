import { ChevronDown, UserRound } from "lucide-react";
import { useEnterpriseIdentity } from "@/hooks/useEnterpriseIdentity.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
  const { intl } = useZCodeIntl();
  if (!identity) return null;
  const t = (id: string) => intl.formatMessage({ id: `enterpriseIdentity.${id}` });
  const profile = identity.view?.status === "authenticated" ? identity.view.profile : null;
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
          title={profile.displayName}
          data-testid="enterprise-identity-name"
        >
          <UserRound className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{profile.displayName}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{profile.displayName}</DropdownMenuLabel>
        <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
          {t("source")}
        </DropdownMenuLabel>
        {identity.allowLogin ? (
          <>
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
