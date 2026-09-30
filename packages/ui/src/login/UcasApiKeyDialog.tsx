import { useState, type FormEvent } from "react";
import type { IProviderSettingsService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { saveUcasApiKey } from "./ucasApiKeyPrompt.js";

export function UcasApiKeyDialog({
  providerSettingsService,
  onClose,
}: {
  providerSettingsService: Pick<IProviderSettingsService, "setUcasApiKeyIfMissing">;
  onClose(): void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `enterpriseIdentity.ucasKey.${id}` });
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!key.trim() || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await saveUcasApiKey(providerSettingsService, key);
      onClose();
    } catch {
      // 错误可能包含服务端诊断或凭据；界面只显示固定文案并保留输入以供重试。
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-md p-5 sm:p-6"
        data-testid="ucas-api-key-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-ui-lg">{t("title")}</DialogTitle>
          <DialogDescription className="text-ui-sm">{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void save(event)} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="ucas-api-key-input" className="text-ui-base font-medium">
              {t("label")}
            </label>
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id="ucas-api-key-input"
              type="password"
              size="lg"
              data-testid="ucas-api-key-input"
              value={key}
              onChange={(event) => {
                setKey(event.target.value);
                if (failed) setFailed(false);
              }}
              aria-invalid={failed}
              className="h-9"
            />
            {failed ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {t("failure")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
              data-testid="ucas-api-key-later"
            >
              {t("later")}
            </Button>
            <Button type="submit" disabled={!key.trim() || saving} data-testid="ucas-api-key-save">
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
