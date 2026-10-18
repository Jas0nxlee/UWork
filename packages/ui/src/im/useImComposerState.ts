import { useEffect, useRef, useState, type RefObject } from "react";
import type { IImService } from "@zcode/services";
import type { ImMessage } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { ImOutboxReply } from "./imOutbox.js";
import type { ImConversationController } from "./useIm.js";

/**
 * 输入区的全部状态与动作：草稿、回复、提及、编辑、附件。
 *
 * 抽出来的理由：这些字段互相咬得紧（发送时要同时清草稿/回复/提及、编辑态要用草稿做预填、
 * 附件走同一条乐观发送路径），散在面板里会让"发送"这件事横跨 80 行 JSX 之间的代码。
 * 面板只关心"渲染它"和"给它会话"。
 */
export interface ImComposerState {
  draft: string;
  setDraft: (value: string) => void;
  replyTo: ImMessage | null;
  setReplyTo: (message: ImMessage | null) => void;
  mentions: string[];
  setMentions: (ids: string[]) => void;
  editing: ImMessage | null;
  setEditing: (message: ImMessage | null) => void;
  uploading: boolean;
  actionError: string | null;
  setActionError: (message: string | null) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  submit: (mentionIds: string[]) => Promise<void>;
  submitEdit: (body: string) => Promise<void>;
  sendFiles: (files: FileList | null) => Promise<void>;
}

const draftKey = (conversationId: string): string => `uwork:im-draft:${conversationId}`;

export function useImComposerState(options: {
  service: IImService | null;
  conversationId: string;
  conversation: ImConversationController;
  /** 编辑保存后跳回那条消息（面板持有时间线 DOM）。 */
  onEdited: (messageId: string) => void;
}): ImComposerState {
  const { service, conversationId, conversation } = options;
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<ImMessage | null>(null);
  const [mentions, setMentions] = useState<string[]>([]);
  /** 正在编辑的消息（null = 正常发送模式）。 */
  const [editing, setEditing] = useState<ImMessage | null>(null);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 回车提交时读 ref（submit 不放进依赖回复状态的 useCallback，免得每次改引用都重建）
  const replyToRef = useRef<ImOutboxReply | null>(null);
  replyToRef.current = replyTo
    ? { messageId: replyTo.id, senderId: replyTo.senderId, body: replyTo.body }
    : null;

  // 草稿按会话保存：切来切去不该丢正在打的字。
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    setDraft(localStorage.getItem(draftKey(conversationId)) ?? "");
  }, [conversationId]);
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    if (draft) localStorage.setItem(draftKey(conversationId), draft);
    else localStorage.removeItem(draftKey(conversationId));
  }, [conversationId, draft]);

  /** 保存编辑：只有正文会变，服务端广播 message_updated，两端一起刷新。 */
  const submitEdit = async (body: string): Promise<void> => {
    if (!service || !editing) return;
    const target = editing;
    setEditing(null);
    setActionError(null);
    try {
      await service.editMessage({ conversationId, messageId: target.id, body });
      window.setTimeout(() => options.onEdited(target.id), 50);
    } catch (error) {
      logger.warn("[im] 编辑消息失败", error);
      setActionError(intl.formatMessage({ id: "im.editFailed" }));
    }
  };

  const submit = async (mentionIds: string[]): Promise<void> => {
    const body = draft;
    if (!body.trim() || conversation.sending) return;
    const reply = replyToRef.current;
    setDraft("");
    setReplyTo(null);
    setMentions([]);
    setActionError(null);
    const ok = await conversation.send(body, reply, mentionIds);
    if (!ok) setActionError(intl.formatMessage({ id: "im.sendFailed" }));
  };

  /**
   * 附件：先上传拿描述符，再按普通消息发出去（body 是载荷 JSON）。
   * 上传失败不发消息——一个指向不存在附件的消息比"发送失败"更糟。
   */
  const sendFiles = async (files: FileList | null): Promise<void> => {
    if (!service || !files || files.length === 0) return;
    setActionError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 5)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const attachment = await service.uploadAttachment({
          conversationId,
          name: file.name,
          mime: file.type || "application/octet-stream",
          bytes,
        });
        const ok = await conversation.sendAttachment(
          JSON.stringify({
            attachmentId: attachment.id,
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
          }),
        );
        if (!ok) setActionError(intl.formatMessage({ id: "im.sendFailed" }));
      }
    } catch (error) {
      logger.warn("[im] 附件上传失败", error);
      setActionError(intl.formatMessage({ id: "im.attachmentUploadFailed" }));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return {
    draft,
    setDraft,
    replyTo,
    setReplyTo,
    mentions,
    setMentions,
    editing,
    setEditing,
    uploading,
    actionError,
    setActionError,
    fileInputRef,
    submit,
    submitEdit,
    sendFiles,
  };
}
