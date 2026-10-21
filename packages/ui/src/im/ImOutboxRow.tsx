import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseImAttachmentBody } from "@zcode/shared";
import { IM_MESSAGE_BODY, IM_MESSAGE_NAME, IM_MESSAGE_TIME } from "./imChrome.js";
import type { ImOutboxItem } from "./imOutbox.js";
import { initialsOf } from "./imPresentation.js";

export function ImOutboxRow({
  item,
  selfLabel,
  onRetry,
  onDiscard,
}: {
  item: ImOutboxItem;
  selfLabel: string;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string): string => intl.formatMessage({ id });
  const failed = item.status === "failed";
  return (
    <div
      data-im-outbox-id={item.clientMsgId}
      data-im-outbox-status={item.status}
      className="mt-3 flex gap-3"
    >
      <span className="w-9 shrink-0">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-ui-2xs font-medium text-muted-foreground">
          {initialsOf(selfLabel)}
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={IM_MESSAGE_NAME}>{selfLabel}</span>
          <span className={IM_MESSAGE_TIME}>{failed ? t("im.sendFailed") : t("im.sending")}</span>
        </div>
        {item.replyTo ? (
          <p className="mt-1 border-l-2 border-border pl-2 text-ui-2xs text-muted-foreground">
            {item.replyTo.body}
          </p>
        ) : null}
        <p className={cn(IM_MESSAGE_BODY, failed && "text-foreground-subtle")}>
          {parseImAttachmentBody(item.body)?.name ?? item.body}
        </p>
        {failed ? (
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-ui-2xs text-primary hover:bg-accent"
              onClick={onRetry}
            >
              {t("im.retrySend")}
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-ui-2xs text-muted-foreground hover:bg-accent"
              onClick={onDiscard}
            >
              {t("im.discardSend")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
