import { Building2 } from "lucide-react";
import type { EnterpriseLoginSurface } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { EnterpriseQrSurface } from "./EnterpriseQrSurface.js";

export function EnterpriseLoginPage({
  configured,
  waiting,
  error,
  expired,
  onLogin,
  onSkip,
  onSurface,
}: {
  configured: boolean | null;
  waiting: boolean;
  error: boolean;
  expired: boolean;
  onLogin(): void;
  onSkip(): void;
  onSurface(surface: EnterpriseLoginSurface | null): void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `enterpriseIdentity.${id}` });
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
            {waiting ? (
              <>
                <EnterpriseQrSurface onSurface={onSurface} label={t("qrLabel")} />
                <p className="text-center text-ui-caption text-foreground-subtle">
                  {t("scanHint")}
                </p>
              </>
            ) : (
              <Button
                className="w-full"
                onClick={onLogin}
                disabled={!configured || waiting}
                data-testid="enterprise-wecom-login"
              >
                <Building2 className="size-4" aria-hidden="true" />
                {t("wecomLogin")}
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
