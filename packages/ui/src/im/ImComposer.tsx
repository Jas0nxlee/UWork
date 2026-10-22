import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ImMessage } from "@zcode/shared";
import { LoaderCircleIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { messageBodyText } from "./imPresentation.js";
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
  editing,
  onEditSave,
  onEditCancel,
  mentionCandidates,
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
  mentions,
  onMentionsChange,
}: {
  /** 正在编辑的消息（null = 普通发送）。编辑时输入区进入"编辑态"：预填正文 + 保存/取消。 */
  editing: ImMessage | null;
  onEditSave: (body: string) => void;
  onEditCancel: () => void;
  /** @提及的候选（本会话成员 + 全体）。空数组表示这个会话不支持提及（单聊）。 */
  mentionCandidates: { id: string; name: string }[];
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
  onSubmit: (mentionIds: string[]) => void;
  onFiles: (files: FileList | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onTyping: () => void;
  /** 提交时带出的 @提及（由输入框自己收集：它知道用户点了谁）。 */
  mentions: string[];
  onMentionsChange: (ids: string[]) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);

  /**
   * @ 提及：光标前是 `@` + 若干字时弹候选。
   *
   * 只做"@ 开头"这一种触发（不在词中间触发，邮箱地址不会误弹）；
   * 选人后把 `@名字 ` 插进正文，并把 id 收集起来——**id 由服务端校验与记录**，
   * 正文里那串字只是给人看的（改名后老消息仍然对）。
   */
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  /** 有文件悬在这块区域上方：给一条「松开就发」的提示，免得用户以为拖进来没反应。 */
  const [dragActive, setDragActive] = useState(false);
  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const needle = mentionQuery.trim().toLowerCase();
    return mentionCandidates
      .filter((candidate) => !needle || candidate.name.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [mentionCandidates, mentionQuery]);

  const updateMentionQuery = (value: string, caret: number): void => {
    const before = value.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]{0,24})$/u.exec(before);
    setMentionQuery(match ? (match[1] ?? "") : null);
  };

  const pickMention = (candidate: { id: string; name: string }): void => {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret).replace(/@([^\s@]{0,24})$/u, "");
    const after = draft.slice(caret);
    const next = `${before}@${candidate.name} ${after}`;
    onDraftChange(next);
    // 同名多次 @ 只记一次 id；删掉正文里的 @名字 会在提交前被过滤掉（见下方 filter）
    onMentionsChange([...new Set([...mentions, candidate.id])]);
    setMentionQuery(null);
    window.setTimeout(() => {
      textarea?.focus();
      const position = before.length + candidate.name.length + 2;
      textarea?.setSelectionRange(position, position);
    }, 0);
  };

  /** 提交前过滤：正文里已经删掉的 @ 不该还算一次提及。 */
  const activeMentionIds = (): string[] =>
    mentions.filter((id) => {
      const candidate = mentionCandidates.find((item) => item.id === id);
      if (!candidate) return id === "all"; // @全体 在候选里叫"全体"
      return draft.includes(`@${candidate.name}`);
    });

  useEffect(() => {
    if (editing) onDraftChange(editing.body);
    // 只关心"进入/退出编辑"，不跟着正文变化走（否则打字会被自己覆盖）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  return (
    <div
      className={cn(IM_COMPOSER_WRAP, dragActive && "bg-surface/60")}
      onDragOver={(event) => {
        // 只接文件：没有这层判断的话，拖一段选中的文字经过输入框也会亮起来。
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        // 拖过子元素会连着触发 dragleave：指针真的离开这块区域才收起来。
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer) return;
        event.preventDefault();
        setDragActive(false);
        const files = event.dataTransfer.files;
        // 从文件树拖入只有路径、没有 File（渲染层读不到字节，缺宿主能力），这里不做假的成功。
        if (files.length === 0) return;
        onFiles(files);
      }}
    >
      {dragActive ? (
        <p
          data-testid="im-drop-hint"
          className="mb-2 rounded-lg border border-dashed border-primary/50 px-3 py-1.5 text-center text-ui-2xs text-foreground-subtle"
        >
          {t("im.dropToSend")}
        </p>
      ) : null}
      <div className={IM_CONTENT_WIDTH}>
        {editing ? (
          <div
            data-testid="im-edit-strip"
            className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <p className="text-ui-2xs font-medium text-foreground">{t("im.editing")}</p>
              <p className="truncate text-ui-2xs text-foreground-subtle">{editing.body}</p>
            </div>
            <Button
              className="size-6 shrink-0 rounded-md p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              variant="ghost"
              aria-label={t("common.cancel")}
              onClick={onEditCancel}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ) : replyTo ? (
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
                {messageBodyText(replyTo, t, nameOf)}
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
          {mentionQuery !== null && candidates.length > 0 ? (
            <ul
              data-testid="im-mention-picker"
              className="absolute bottom-12 left-2 z-20 max-h-56 w-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
            >
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-left text-ui-xs text-foreground hover:bg-surface-hover"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pickMention(candidate);
                    }}
                  >
                    {candidate.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Textarea
            ref={textareaRef}
            className={IM_COMPOSER_INPUT}
            placeholder={t("im.composerPlaceholder")}
            value={draft}
            disabled={sending}
            onChange={(event) => {
              onDraftChange(event.target.value);
              updateMentionQuery(event.target.value, event.target.selectionStart ?? 0);
              if (event.target.value.trim()) onTyping();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (editing) {
                  event.preventDefault();
                  onEditCancel();
                  return;
                }
                if (replyTo) {
                  event.preventDefault();
                  onCancelReply();
                  return;
                }
              }
              if (event.key === "Escape" && mentionQuery !== null) {
                event.preventDefault();
                setMentionQuery(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                // 候选开着时回车是"选第一个人"，不是发送
                if (mentionQuery !== null && candidates[0]) {
                  pickMention(candidates[0]);
                  return;
                }
                if (editing) onEditSave(draft);
                else onSubmit(activeMentionIds());
              }
            }}
          />
          <Button
            size="icon"
            className="size-8 shrink-0 rounded-lg shadow-none"
            disabled={sending || draft.trim().length === 0}
            onClick={() => (editing ? onEditSave(draft) : onSubmit(activeMentionIds()))}
            aria-label={editing ? t("im.editSave") : t("im.send")}
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
