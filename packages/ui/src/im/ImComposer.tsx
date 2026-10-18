import { memo } from "react";
import type { ImMessage } from "@zcode/shared";
import { LoaderCircleIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  IM_COMPOSER_BOX,
  IM_COMPOSER_INPUT,
  IM_COMPOSER_WRAP,
  IM_CONTENT_WIDTH,
  IM_HINT,
} from "./imChrome.js";

/**
 * 输入区。
 *
 * 抽成独立组件不只是为了行数：它有自己的状态生命周期（引用条、上传中、正在输入提示、草稿快捷键），
 * 混在面板里会让面板同时管"会话编排"和"输入交互"两件事。
 */
export const ImComposer = memo(function ImComposer({
  replyTo,
  selfUserId,
  selfName,
  nameOf,
  draft,
  onDraftChange,
  sending,
  uploading,
  typingLabel,
  actionError,
  onCancelReply,
  onSubmit,
  onFiles,
  fileInputRef,
  onTyping,
}: {
  replyTo: ImMessage | null;
  selfUserId: string | null;
  selfName: string | null;
  nameOf: (id: string) => string | undefined;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  uploading: boolean;
  typingLabel: string | null;
  actionError: string | null;
  onCancelReply: () => void;
  onSubmit: () => void;
  onFiles: (files: FileList | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onTyping: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);

  return (
    <div className={IM_COMPOSER_WRAP}>
      <div className={IM_CONTENT_WIDTH}>
        {replyTo ? (
          <div
            data-testid="im-reply-strip"
            className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-ui-2xs font-medium text-foreground">
                {t("im.replyingTo", {
                  name:
                    (replyTo.senderId === selfUserId ? selfName : nameOf(replyTo.senderId)) ??
                    replyTo.senderId,
                })}
              </p>
              <p className="truncate text-ui-2xs text-foreground-subtle">
                {replyTo.deletedAt !== null ? t("im.withdrawn") : replyTo.body}
              </p>
            </div>
            <Button
              className="size-6 shrink-0 rounded-md p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              variant="ghost"
              aria-label={t("common.cancel")}
              onClick={onCancelReply}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ) : null}
        <div className={IM_COMPOSER_BOX}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            data-testid="im-attachment-input"
            onChange={(event) => onFiles(event.target.files)}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0 rounded-lg p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            aria-label={t("im.attach")}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : (
              <PaperclipIcon className="size-4" />
            )}
          </Button>
          <Textarea
            className={IM_COMPOSER_INPUT}
            placeholder={t("im.composerPlaceholder")}
            value={draft}
            disabled={sending}
            onChange={(event) => {
              onDraftChange(event.target.value);
              if (event.target.value.trim()) onTyping();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && replyTo) {
                event.preventDefault();
                onCancelReply();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          <Button
            size="icon"
            className="size-8 shrink-0 rounded-lg shadow-none"
            disabled={sending || draft.trim().length === 0}
            onClick={onSubmit}
            aria-label={t("im.send")}
          >
            <SendIcon className="size-4" />
          </Button>
        </div>
        <div className="mt-1.5 flex items-center justify-between px-1">
          <span className={cn(IM_HINT, actionError && "text-destructive")}>
            {actionError ?? typingLabel ?? ""}
          </span>
          <span className={IM_HINT}>{t("im.composerHint")}</span>
        </div>
      </div>
    </div>
  );
});
