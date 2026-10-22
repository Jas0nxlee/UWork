import { useCallback, useEffect, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImMessage } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * 撤回。
 *
 * 两种入口的交互不同，所以有两个方法：
 * - 悬停工具条：**两步确认**（先点一次进入确认态，再点一次才撤）——鼠标就在旁边，误触代价高；
 * - 右键菜单：**点击即撤**——菜单点完就关，没法要求"再点一次"，两步在这里只会让人以为没生效。
 *
 * 换会话要清掉确认态与错误：留着上一个会话的"确认撤回"会在新会话里误撤。
 */
export function useImWithdraw(
  service: IImService | null,
  conversationId: string | null,
): {
  confirmingId: string | null;
  actionError: string | null;
  setActionError: (value: string | null) => void;
  resetWithdraw: () => void;
  onWithdraw: (message: ImMessage) => void;
  onWithdrawNow: (message: ImMessage) => void;
} {
  const { intl } = useZCodeIntl();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const resetWithdraw = useCallback(() => {
    setConfirmingId(null);
  }, []);

  useEffect(() => {
    setConfirmingId(null);
    setActionError(null);
  }, [conversationId]);

  const run = useCallback(
    (message: ImMessage): void => {
      if (!service || !conversationId) return;
      setActionError(null);
      void service
        .withdrawMessage({ conversationId, messageId: message.id })
        .catch((error: unknown) => {
          logger.warn("[im] 撤回失败", error);
          setActionError(intl.formatMessage({ id: "im.withdrawFailed" }));
        });
    },
    [service, conversationId, intl],
  );

  const onWithdraw = useCallback(
    (message: ImMessage): void => {
      if (confirmingId !== message.id) {
        setConfirmingId(message.id);
        return;
      }
      setConfirmingId(null);
      run(message);
    },
    [confirmingId, run],
  );

  const onWithdrawNow = useCallback(
    (message: ImMessage): void => {
      setConfirmingId(null);
      run(message);
    },
    [run],
  );

  return { confirmingId, actionError, setActionError, resetWithdraw, onWithdraw, onWithdrawNow };
}
