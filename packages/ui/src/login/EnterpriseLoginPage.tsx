import { Building2 } from "lucide-react";
import type { EnterpriseLoginSurface } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { EnterpriseQrSurface } from "./EnterpriseQrSurface.js";

/** 组织条目来自已校验的公开配置；这里只负责展示与选择，不参与授权。 */
export interface EnterpriseLoginOrganization {
  id: string;
  label: string | null;
}

export function EnterpriseLoginPage({
  configured,
  waiting,
  organizations,
  selectedOrgId,
  error,
  expired,
  onLogin,
  onSelectOrg,
  onBackToOrganizations,
  onSkip,
  onSurface,
}: {
  configured: boolean | null;
  waiting: boolean;
  organizations: readonly EnterpriseLoginOrganization[];
  selectedOrgId: string | null;
  error: boolean;
  expired: boolean;
  onLogin(): void;
  onSelectOrg(id: string): void;
  /** 二维码阶段返回公司选择（取消当前尝试，不关闭登录入口）。 */
  onBackToOrganizations(): void;
  onSkip(): void;
  onSurface(surface: EnterpriseLoginSurface | null): void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `enterpriseIdentity.${id}` });
  const organizationName = (organization: EnterpriseLoginOrganization) =>
    organization.label ?? organization.id;
  const selectedOrganization =
    organizations.find((organization) => organization.id === selectedOrgId) ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onSkip();
      }}
    >
      <DialogContent
        showCloseButton={false}
        overlayClassName="z-[70] bg-background data-open:animate-none data-closed:animate-none"
        className="inset-0 left-0 top-0 z-[70] flex h-dvh max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-y-auto rounded-none border-0 bg-background px-6 py-12 shadow-none data-open:animate-none data-closed:animate-none"
        data-testid="enterprise-login-page"
      >
        <div className="absolute inset-x-0 top-0 h-10 [app-region:drag]" aria-hidden="true" />
        <section
          className="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-6 [app-region:no-drag]"
          data-testid="enterprise-login-card"
        >
          <div>
            <DialogTitle className="text-ui-lg font-medium">
              {waiting ? t("wecomLogin") : t("title")}
            </DialogTitle>
            <DialogDescription className="sr-only">{t("scanHint")}</DialogDescription>
          </div>
          <div className="space-y-3">
            {/* 多公司：选择只决定用哪家企微应用扫码，登录后仍以服务端回包的组织为准。 */}
            {!waiting && organizations.length > 1 ? (
              <div className="space-y-1.5">
                <p
                  className="text-ui-caption text-foreground-subtle"
                  id="enterprise-login-org-label"
                >
                  {t("chooseOrganization")}
                </p>
                <div
                  className="flex flex-wrap gap-1.5"
                  role="radiogroup"
                  aria-labelledby="enterprise-login-org-label"
                >
                  {organizations.map((organization) => {
                    const selected = organization.id === selectedOrgId;
                    return (
                      <button
                        key={organization.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={cn(
                          "rounded-full px-3 py-1 text-ui-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                          selected
                            ? "bg-selected text-foreground"
                            : "text-foreground-subtle hover:bg-hover hover:text-foreground",
                        )}
                        data-testid="enterprise-login-organization"
                        data-org-id={organization.id}
                        onClick={() => onSelectOrg(organization.id)}
                      >
                        {organizationName(organization)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {waiting ? (
              <>
                {selectedOrganization ? (
                  <p
                    className="text-center text-ui-caption text-foreground-subtle"
                    data-testid="enterprise-login-organization-current"
                  >
                    {organizationName(selectedOrganization)}
                  </p>
                ) : null}
                <EnterpriseQrSurface onSurface={onSurface} label={t("qrLabel")} />
                <p className="text-center text-ui-caption text-foreground-subtle">
                  {t("scanHint")}
                </p>
                {/* 选错了公司要有回头路：取消本次尝试回到选择器，不必退出整个登录入口。 */}
                {organizations.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={onBackToOrganizations}
                    data-testid="enterprise-login-organization-back"
                  >
                    {t("chooseAnotherOrganization")}
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                className="w-full"
                onClick={onLogin}
                disabled={!configured || waiting}
                data-testid="enterprise-wecom-login"
              >
                <Building2 className="size-4" aria-hidden="true" />
                {selectedOrganization && organizations.length > 1
                  ? t("wecomLoginWithOrganization").replace(
                      "{organization}",
                      organizationName(selectedOrganization),
                    )
                  : t("wecomLogin")}
              </Button>
            )}
            {configured === null ? (
              <p className="text-ui-sm text-foreground-subtle" role="status">
                {t("checking")}
              </p>
            ) : null}
            {configured === false ? (
              <p className="text-ui-sm text-foreground-subtle" role="status">
                {t("unconfigured")}
              </p>
            ) : null}
            {waiting ? (
              <p className="sr-only" role="status" aria-live="polite">
                {t("waiting")}
              </p>
            ) : null}
            {error ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {t("failed")}
              </p>
            ) : null}
            {expired ? (
              <p className="text-ui-sm text-foreground-subtle" role="status">
                {t("expired")}
              </p>
            ) : null}
            <Button
              variant="outline"
              className="w-full"
              onClick={onSkip}
              data-testid="enterprise-login-skip"
            >
              {t("skip")}
            </Button>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
