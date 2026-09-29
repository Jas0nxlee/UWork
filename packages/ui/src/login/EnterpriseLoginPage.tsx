import { Building2, LoaderCircle } from "lucide-react";
import { UWorkLogo, UWorkWordmark } from "@/components/ui/UWorkLogo.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";

export function EnterpriseLoginPage({
  configured,
  waiting,
  error,
  expired,
  onLogin,
  onSkip,
}: {
  configured: boolean;
  waiting: boolean;
  error: boolean;
  expired: boolean;
  onLogin(): void;
  onSkip(): void;
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
        <section className="w-full max-w-sm space-y-6 rounded-xl border border-border bg-card p-6 [app-region:no-drag]">
          <div className="flex items-center gap-3">
            <UWorkLogo className="size-10" />
            <UWorkWordmark className="h-11 w-40" />
          </div>
          <div className="space-y-2">
            <DialogTitle className="text-ui-lg font-medium">{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </div>
          <div className="space-y-3">
            <Button
              className="w-full"
              onClick={onLogin}
              disabled={!configured || waiting}
              data-testid="enterprise-wecom-login"
            >
              {waiting ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Building2 className="size-4" aria-hidden="true" />
              )}
              {waiting ? t("waiting") : t("wecomLogin")}
            </Button>
            {!configured ? (
              <p className="text-ui-sm text-foreground-subtle" role="status">
                {t("unconfigured")}
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
          <p className="text-ui-sm text-foreground-subtlest">{t("localUsage")}</p>
        </section>
      </DialogContent>
    </Dialog>
  );
}
