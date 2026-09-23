import { useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { ProviderModelDiscoveryResult } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ModelDiscoveryButton({
  onDiscover,
}: {
  onDiscover: () => Promise<ProviderModelDiscoveryResult>;
}) {
  const { intl } = useZCodeIntl();
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Pick<
    ProviderModelDiscoveryResult,
    "discovered" | "added" | "skipped"
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const discover = async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const next = await onDiscover();
      setResult({ discovered: next.discovered, added: next.added, skipped: next.skipped });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : intl.formatMessage({ id: "settings.modelProvider.discoveryFailed" }),
      );
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        className="rounded-lg"
        data-testid="model-provider-discover-models-button"
        disabled={loading}
        onClick={() => void discover()}
      >
        {loading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        {intl.formatMessage({
          id: loading
            ? "settings.modelProvider.discoveringModels"
            : "settings.modelProvider.discoverModels",
        })}
      </Button>
      {result ? (
        <span
          role="status"
          data-testid="model-provider-discovery-result"
          className="text-ui-sm text-foreground-subtle"
        >
          {intl.formatMessage(
            {
              id:
                result.discovered === 0
                  ? "settings.modelProvider.discoveryEmpty"
                  : "settings.modelProvider.discoveryResult",
            },
            { ...result },
          )}
        </span>
      ) : null}
      {error ? (
        <span
          role="alert"
          data-testid="model-provider-discovery-error"
          className="max-w-80 break-words text-ui-sm text-destructive"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
