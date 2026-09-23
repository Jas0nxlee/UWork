import { cn } from "@/components/lib/utils.js";
import { UWorkWordmark } from "@/components/ui/UWorkLogo.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/** 复用唯一的界面模式 Store；入口之间不维护第二份选择状态。 */
export function WorkspaceModeHeader() {
  const { intl } = useZCodeIntl();
  const mode = useZCodeStore((state) => state.interfaceMode);
  const setMode = useZCodeStore((state) => state.setInterfaceMode);
  return (
    <div className="mb-2 min-w-0 space-y-2 px-1" data-testid="workspace-mode-header">
      <UWorkWordmark className="h-11 w-auto max-w-full text-foreground" />
      <div
        role="group"
        aria-label={intl.formatMessage({ id: "settings.interfaceMode" })}
        className="flex w-full max-w-48 rounded-lg border border-border bg-surface p-0.5"
      >
        {(["office", "coding"] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-testid={`interface-mode-${value}`}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={cn(
              "min-w-0 flex-1 rounded-md px-3 py-1 text-ui-base font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              mode === value
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-foreground hover:bg-hover",
            )}
          >
            {intl.formatMessage({ id: `settings.interfaceMode.${value}` })}
          </button>
        ))}
      </div>
    </div>
  );
}
