import { ArrowLeftRight } from "lucide-react";
import { UWorkWordmark } from "@/components/ui/UWorkLogo.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/** 复用唯一的界面模式 Store；入口之间不维护第二份选择状态。 */
export function WorkspaceModeHeader() {
  const { intl } = useZCodeIntl();
  const mode = useZCodeStore((state) => state.interfaceMode);
  const setMode = useZCodeStore((state) => state.setInterfaceMode);
  const nextMode = mode === "office" ? "coding" : "office";
  const currentLabel = intl.formatMessage({ id: `settings.interfaceMode.${mode}` });
  const toggleLabel = intl.formatMessage(
    { id: "settings.interfaceMode.toggle" },
    {
      current: currentLabel,
      next: intl.formatMessage({ id: `settings.interfaceMode.${nextMode}` }),
    },
  );
  return (
    <div className="mb-2 flex min-w-0 items-center gap-2 px-1" data-testid="workspace-mode-header">
      <UWorkWordmark className="h-11 w-40 min-w-0 shrink text-foreground" />
      <button
        type="button"
        data-testid="interface-mode-toggle"
        data-interface-mode={mode}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={() => setMode(nextMode)}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border bg-surface px-2 text-ui-base font-bold text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{currentLabel}</span>
        <ArrowLeftRight className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}
