import { useCallback, useState } from "react";
import type { IImService } from "./contract.js";
import type { ImCardDocument } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveImCardAction } from "./imPresentation.js";

/**
 * 卡片动作的分派（`server` 动作的执行者，见 specs/messaging-and-channels.md §12.18）。
 *
 * 抽成 hook 而不是写在面板 JSX 里：面板已经承担"布局与状态编排"，而这里的规则
 * （哪些动作直提、哪些要弹窗、未识别怎么办）是要能被穷举单测的**行为**。
 * 分派本身是纯的（`resolveImCardAction`），这里只接三件事：调服务、开/关退回弹窗、抛人话错误。
 */
/**
 * 把审核失败的原因说成人话。
 *
 * 服务端说的是英文短句（`author cannot review own item` 这类），而看屏幕的是部门同事；
 * **已知的几条**翻过来，其余原样显示——原样也远比"IM request failed: 400"有用
 * （真机踩到：作者点自己那张卡，界面只显示 400，看不出为什么）。
 */
const REVIEW_FAILURE_MESSAGES: Record<string, string> = {
  "author cannot review own item": "im.cardReviewSelf",
  "comment required when returning": "im.cardReturnCommentRequired",
};

function explainReviewFailure(
  error: unknown,
  intl: { formatMessage: (input: { id: string }) => string },
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const mapped = REVIEW_FAILURE_MESSAGES[raw];
  return mapped ? intl.formatMessage({ id: mapped }) : raw;
}

export function useImCardActionDispatch(input: {
  service: IImService | null;
  /** `client` 动作「查看详情」的去处：交给面板打开详情弹窗。 */
  onOpenItem: (itemId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { service, onOpenItem } = input;
  /** 需要写意见的退回：先开弹窗，提交与校验都在弹窗里做。 */
  const [returningReview, setReturningReview] = useState<{
    itemId: string;
    title: string;
  } | null>(null);

  const dispatch = useCallback(
    async (
      action: { id: string; kind: "client" | "server"; target?: string },
      document: ImCardDocument,
    ): Promise<void> => {
      // 传 document：动作自身没带 target 的存量卡片要能靠同卡片其它动作的 target 兜底（真机踩到过）。
      const resolved = resolveImCardAction(action, document);
      if (resolved.kind === "unsupported")
        throw new Error(intl.formatMessage({ id: "im.cardActionUnsupported" }));
      if (resolved.action === "open") {
        onOpenItem(resolved.itemId);
        return;
      }
      if (!service) throw new Error(intl.formatMessage({ id: "im.cardActionUnavailable" }));
      if (resolved.action === "review") {
        // 「已阅」是最短动作：直接执行，不去加一层确认。失败由服务端说了算——
        // 服务端的原话要能看懂：已知的几条原因翻成人话，其余原样显示（见 explainReviewFailure）。
        await service
          .reviewWorkItem({ itemId: resolved.itemId, status: "reviewed" })
          .catch((error: unknown) => {
            throw new Error(explainReviewFailure(error, intl));
          });
        return;
      }
      setReturningReview({ itemId: resolved.itemId, title: document.title });
    },
    [intl, onOpenItem, service],
  );

  return {
    dispatch,
    returningReview,
    closeReturn: useCallback(() => setReturningReview(null), []),
  };
}
