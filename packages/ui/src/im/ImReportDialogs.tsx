import { memo } from "react";
import type { IImService } from "@zcode/services";
import type { ImDirectoryUser } from "@zcode/shared";
import { ImReportComposeDialog } from "./ImReportComposeDialog.js";
import { ImReportDialog } from "./ImReportDialog.js";

/**
 * 汇报的两个弹窗（写 / 看）。抽出来只是为了让主面板回到"布局与状态编排"这条主线上——
 * 弹窗的开关状态仍由面板持有（它才知道提交后该切到哪条会话）。
 */
export const ImReportDialogs = memo(function ImReportDialogs({
  service,
  selfUserId,
  directory,
  composing,
  openReportId,
  nameOf,
  onCloseCompose,
  onCloseDetail,
  onSubmitted,
}: {
  service: IImService | null;
  selfUserId: string | null;
  directory: ImDirectoryUser[];
  composing: boolean;
  openReportId: string | null;
  nameOf: (id: string) => string | undefined;
  onCloseCompose: () => void;
  onCloseDetail: () => void;
  onSubmitted: (input: { conversationId: string; recipientId: string }) => void;
}) {
  return (
    <>
      {composing ? (
        <ImReportComposeDialog
          service={service}
          selfUserId={selfUserId}
          directory={directory}
          onClose={onCloseCompose}
          onSubmitted={onSubmitted}
        />
      ) : null}
      <ImReportDialog
        service={service}
        reportId={openReportId}
        nameOf={nameOf}
        onClose={onCloseDetail}
      />
    </>
  );
});
