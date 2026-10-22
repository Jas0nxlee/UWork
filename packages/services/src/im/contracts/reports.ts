import type { ImMessage, ImWorkReport } from "@zcode/shared";

/** 既有 RPC 服务的能力分组；方法名与参数保持兼容。 */
export interface ImReportCommands {
  /** 提交工作汇报：服务端落库并给收件人投一张卡片（正文与附件都在服务端）。 */
  submitReport(input: {
    periodKey: string;
    title: string;
    summary?: string;
    content?: string;
    problems?: string;
    type?: string;
    tags?: string[];
    attachmentIds?: string[];
    recipientIds: string[];
  }): Promise<{ report: ImWorkReport; message: ImMessage }>;
  /**
   * 卡片上的服务端动作（「已阅 / 退回」）。**授权由服务端判**：非审核人拿到 403 原文，
   * 客户端只负责显示，不做按钮级预判（specs/messaging-and-channels.md §12.18）。
   */
  reviewWorkItem(input: {
    itemId: string;
    status: "reviewed" | "returned";
    comment?: string;
  }): Promise<{ itemId: string; status: string }>;
  /** 我发的 + 我收到的汇报（云端记录，可按周期过滤）。 */
  listReports(input?: {
    periodKey?: string;
    authorId?: string;
    limit?: number;
  }): Promise<ImWorkReport[]>;
  getReport(reportId: string): Promise<ImWorkReport>;
}
