import { memo, useState } from "react";
import {
  parseImCard,
  type ImCardDocument,
  type ImCardSection,
  type ImCardTone,
} from "@zcode/shared";
import { AlertTriangleIcon, FileTextIcon, PaperclipIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { imCardViewerRole } from "./imPresentation.js";
import {
  CARD_ACCENT,
  CARD_ACTION_PRIMARY,
  CARD_ACTION_SECONDARY,
  CARD_ALERT,
  CARD_ATTACHMENT_ROW,
  CARD_BADGE,
  CARD_BADGE_BASE,
  CARD_BODY,
  CARD_FOOTER,
  CARD_HEADER,
  CARD_ICON_BOX,
  CARD_LABEL,
  CARD_META,
  CARD_SHELL,
  CARD_TEXT,
  CARD_TEXT_TONE,
  CARD_TITLE,
} from "./imCardChrome.js";

/**
 * **通用卡片渲染器**：IM 消息里的卡片是**数据**（`ImCardDocument`），不是为每种卡片写的组件。
 *
 * 三条设计约束（见 `specs/work-reports-and-rollup.md` §8.7）：
 * 1. 只认一小撮原语（text/fields/list/quote/divider/progress）——不认识就**跳过**，不尝试渲染未知结构；
 * 2. 文档解析失败（缺 fallback/type、JSON 坏了、老版本客户端遇到新字段）→ **退化成 fallback 文本**，
 *    永远不给用户一张空白卡片或一串 JSON；
 * 3. `actions` 里 `client` 交给外层处理器（如"查看详情"），`server` 由服务端校验后执行——渲染器不判权限。
 *
 * 视觉上有一点是刻意的：**所有卡片长同一个结构**（类型图标 + 标题 + 元信息 → 分区 → 动作条），
 * 颜色只由 tone 决定。否则"数据驱动"会很快变成"每张卡片一个样子"。
 */
function toneOf(section: ImCardSection): ImCardTone {
  return section.kind === "text" ? (section.tone ?? "default") : "default";
}

function Section({ section }: { section: ImCardSection }) {
  if (section.kind === "divider") return <div className="border-t border-border/70" />;
  if (section.kind === "quote") {
    return (
      <blockquote className="border-l-2 border-border-hover pl-2.5 text-ui-xs text-foreground-subtle">
        {section.text}
      </blockquote>
    );
  }
  if (section.kind === "list") {
    return (
      <div>
        {section.label ? <p className={CARD_LABEL}>{section.label}</p> : null}
        <ul className="mt-1 flex flex-col gap-0.5">
          {section.items.map((item, index) => (
            <li
              key={`${item}-${index}`}
              className="flex gap-2 text-ui-sm leading-5 text-foreground"
            >
              <span className="mt-2 size-1 shrink-0 rounded-full bg-foreground-subtle" />
              <span className="min-w-0 flex-1">{item}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (section.kind === "fields") {
    return (
      <div>
        {section.label ? <p className={CARD_LABEL}>{section.label}</p> : null}
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
          {section.fields.map((field, index) => (
            <div key={`${field.label}-${index}`} className="min-w-0">
              <dt className="text-ui-2xs text-foreground-subtle">{field.label}</dt>
              <dd className="truncate text-ui-sm text-foreground">{field.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  if (section.kind === "progress") {
    const max = section.max && section.max > 0 ? section.max : 100;
    const percent = Math.min(100, Math.max(0, Math.round((section.value / max) * 100)));
    return (
      <div>
        <p className="flex items-baseline justify-between">
          <span className={CARD_LABEL}>{section.label ?? ""}</span>
          <span className="text-ui-2xs text-foreground tabular-nums">{percent}%</span>
        </p>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-background/80">
          <div className="h-full rounded-full bg-primary/70" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  // 问题/风险：底色 + 左描边 + 图标。只把字染红看起来像程序报错，不像"内容里有个坎"。
  if (toneOf(section) === "danger") {
    return (
      <div className={CARD_ALERT}>
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">
          {section.label ? (
            <p className={cn(CARD_LABEL, "text-destructive")}>{section.label}</p>
          ) : null}
          <p className="mt-0.5 whitespace-pre-wrap text-ui-sm leading-5 text-foreground">
            {section.text}
          </p>
        </span>
      </div>
    );
  }
  return (
    <div>
      {section.label ? <p className={CARD_LABEL}>{section.label}</p> : null}
      <p className={cn(CARD_TEXT, CARD_TEXT_TONE[toneOf(section)])}>{section.text}</p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const ImCardRenderer = memo(function ImCardRenderer({
  body,
  authorLabel,
  selfUserId,
  onAction,
}: {
  body: string;
  authorLabel: string;
  /** 观看者本人（决定这张卡按什么视角渲染：收件人可操作 / 发起人所有者视角 / 其他人只读）。 */
  selfUserId?: string | null;
  /**
   * 卡片动作的执行者交给外层（渲染器不认识业务，见 specs/messaging-and-channels.md §12.18）：
   * - `client` 动作 → 打开对应的界面；
   * - `server` 动作 → 带用户令牌调服务端，**授权由服务端判**。
   *
   * 返回 Promise 时渲染器会显示"执行中"，失败把错误原文显示在卡片下方；不传则按钮不可点。
   * 渲染器**不做乐观成功**：这类动作没有回滚语义，宁可多等一拍。
   */
  onAction?: (
    action: { id: string; kind: "client" | "server"; target?: string },
    document: ImCardDocument,
  ) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const document = parseImCard(body);
  /** 执行中的动作 id + 上一次失败原因（就地显示，不弹全局提示——错误属于这张卡）。 */
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!document) {
    // 解析失败：把 body 当作**未知版本**处理，不把 JSON 甩给用户。老客户端遇到新结构也走这里。
    logger.warn("[im] 卡片文档无法解析（版本不匹配？），退化成提示");
    return (
      <p data-testid="im-card-fallback" className="mt-0.5 text-ui-xs text-foreground-subtle italic">
        {intl.formatMessage({ id: "im.cardUnreadable" })}
      </p>
    );
  }

  const sections = document.sections ?? [];
  const attachments = document.attachments ?? [];
  const role = imCardViewerRole(document, selfUserId);
  const allActions = document.actions ?? [];
  // 按视角裁剪：服务端动作只在"收件人"眼里可操作；发起人看到的是"我提交的、等审核人处理"；
  // 其他人只读。老卡片（role=unknown）保持原样，由服务端拒。
  const canActOnServer = role === "addressee" || role === "unknown";
  const actions = canActOnServer
    ? allActions
    : allActions.filter((action) => action.kind !== "server");
  /** 发起人视角且卡片还带着审核动作（＝服务端还没处理）时，用一行说明代替那两个按钮。 */
  const waitingForReview =
    role === "author" && allActions.some((action) => action.kind === "server");
  // 强调条取"这张卡最要紧的一段"：有危险段就用危险色，否则看徽标，最后退回中性。
  const accentTone: ImCardTone = sections.some((section) => toneOf(section) === "danger")
    ? "danger"
    : (document.badges?.find((badge) => badge.tone && badge.tone !== "default")?.tone ?? "default");

  return (
    <div
      data-testid="im-card"
      data-card-type={document.card.type}
      data-card-version={String(document.card.version)}
      className={CARD_SHELL}
    >
      <div className="flex">
        <div className={cn("w-0.5 shrink-0 self-stretch", CARD_ACCENT[accentTone])} />
        <div className="min-w-0 flex-1">
          <div className={CARD_HEADER}>
            <span className={CARD_ICON_BOX}>
              <FileTextIcon className="size-3.5 text-foreground-subtle" />
            </span>
            <span className={CARD_TITLE}>{document.title || document.fallback}</span>
            {(document.badges ?? []).map((badge) => (
              <span
                key={badge.text}
                data-testid="im-card-badge"
                className={cn(CARD_BADGE_BASE, CARD_BADGE[badge.tone ?? "default"])}
              >
                {badge.text}
              </span>
            ))}
          </div>
          <p className={CARD_META}>
            {[document.subtitle, intl.formatMessage({ id: "im.cardFrom" }, { name: authorLabel })]
              .filter(Boolean)
              .join(" · ")}
          </p>

          {sections.length > 0 ? (
            <div className={CARD_BODY}>
              {sections.map((section, index) => (
                <Section key={index} section={section} />
              ))}
            </div>
          ) : null}

          {attachments.length > 0 ? (
            <div className="flex flex-col gap-1 px-3.5 pt-3">
              {attachments.map((attachment) => (
                <div key={attachment.id} className={CARD_ATTACHMENT_ROW}>
                  <PaperclipIcon className="size-3.5 shrink-0 text-foreground-subtle" />
                  <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground">
                    {attachment.name}
                  </span>
                  <span className="shrink-0 text-ui-2xs text-foreground-subtle tabular-nums">
                    {formatBytes(attachment.size)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {actions.length > 0 ? (
            <div className={CARD_FOOTER}>
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  data-testid="im-card-action"
                  data-card-action={action.id}
                  data-card-action-kind={action.kind}
                  disabled={!onAction || pendingAction !== null}
                  className={cn(
                    action.style === "primary" ? CARD_ACTION_PRIMARY : CARD_ACTION_SECONDARY,
                    (!onAction || pendingAction !== null) && "opacity-60",
                  )}
                  onClick={() => {
                    if (!onAction) return;
                    setActionError(null);
                    setPendingAction(action.id);
                    const started = onAction(
                      {
                        id: action.id,
                        kind: action.kind,
                        ...(action.target ? { target: action.target } : {}),
                      },
                      document,
                    );
                    void Promise.resolve(started)
                      .catch((error: unknown) => {
                        // 服务端的原文最有用（"只有审核人能回执"这种），原样展示，不翻译成模糊话术。
                        setActionError(error instanceof Error ? error.message : String(error));
                      })
                      .finally(() => setPendingAction(null));
                  }}
                >
                  {pendingAction === action.id
                    ? intl.formatMessage({ id: "im.cardActionPending" })
                    : action.label}
                </button>
              ))}
            </div>
          ) : null}

          {waitingForReview ? (
            <p
              data-testid="im-card-author-note"
              className={cn(CARD_TEXT, "px-3 pb-2 text-foreground-subtle")}
            >
              {intl.formatMessage({ id: "im.cardAuthorWaiting" })}
            </p>
          ) : null}

          {actionError ? (
            <p
              role="alert"
              data-testid="im-card-action-error"
              className={cn(CARD_TEXT, "px-3 pb-2 text-destructive")}
            >
              {intl.formatMessage({ id: "im.cardActionFailed" }, { reason: actionError })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
});
