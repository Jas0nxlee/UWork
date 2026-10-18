import { memo } from "react";
import type { ImMessage } from "@zcode/shared";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { avatarTone, formatClockTime, initialsOf } from "./imPresentation.js";
import { splitHighlight } from "./imSearch.js";
import { IM_EMPTY, IM_EMPTY_ICON, IM_EMPTY_TEXT, IM_SEARCH_INPUT } from "./imChrome.js";

/**
 * 会话内检索的结果列表。
 *
 * 关键区别：**搜的是整段历史，不是已加载的那一页**。所以这里是一份"结果列表"而不是
 * "在当前屏幕上找下一个"——命中可能在几千条之前，点它要能跳过去（父组件负责加载那段上下文）。
 * 列表按时间倒序给（最近的命中优先），底部有一个"继续往前找"。
 */
export const ImSearchResults = memo(function ImSearchResults({
  query,
  onQueryChange,
  results,
  searching,
  hasMore,
  loadingMore,
  error,
  senderNameOf,
  selfUserId,
  onOpenHit,
  onLoadMore,
  onClose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  results: ImMessage[];
  searching: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  error: string | null;
  senderNameOf: (id: string) => string | undefined;
  selfUserId: string | null;
  onOpenHit: (message: ImMessage) => void;
  onLoadMore: () => void;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>): string =>
    intl.formatMessage({ id }, values);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Input
          autoFocus
          className={cn(IM_SEARCH_INPUT, "flex-1")}
          placeholder={t("im.searchInConversation")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <span className="shrink-0 text-ui-2xs text-foreground-subtle tabular-nums">
          {searching
            ? t("im.searching")
            : query
              ? t("im.searchHits", { count: results.length })
              : ""}
        </span>
        <Button
          className="size-6 shrink-0 rounded-md p-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          variant="ghost"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          ×
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="px-4 py-6 text-center text-ui-xs text-destructive">{error}</p>
        ) : !query ? (
          <div className={cn(IM_EMPTY, "py-10")}>
            <SearchIcon className={IM_EMPTY_ICON} />
            <p className={IM_EMPTY_TEXT}>{t("im.searchScopeAll")}</p>
          </div>
        ) : results.length === 0 && !searching ? (
          <div className={cn(IM_EMPTY, "py-10")}>
            <SearchIcon className={IM_EMPTY_ICON} />
            <p className={IM_EMPTY_TEXT}>{t("im.searchNoMatch")}</p>
          </div>
        ) : (
          <ul className="py-1">
            {results.map((message) => {
              const name =
                message.senderId === selfUserId
                  ? t("im.you")
                  : (senderNameOf(message.senderId) ?? message.senderId);
              return (
                <li key={message.id}>
                  <button
                    type="button"
                    data-testid="im-search-hit"
                    className="flex w-full items-start gap-3 px-4 py-2 text-left transition-colors hover:bg-surface"
                    onClick={() => onOpenHit(message)}
                  >
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-full text-ui-2xs font-medium",
                        avatarTone(message.senderId),
                      )}
                    >
                      {initialsOf(name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
                          {name}
                        </span>
                        <span className="shrink-0 text-ui-2xs text-foreground-subtle tabular-nums">
                          {formatClockTime(message.createdAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-ui-xs text-foreground-subtle">
                        {splitHighlight(message.body, query).map((segment, index) =>
                          segment.match ? (
                            <mark key={index} className="rounded-sm bg-primary/30 text-foreground">
                              {segment.text}
                            </mark>
                          ) : (
                            <span key={index}>{segment.text}</span>
                          ),
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {hasMore && query ? (
              <li className="px-4 py-2">
                <Button
                  variant="ghost"
                  className="h-7 w-full rounded-lg text-ui-xs text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  {loadingMore ? t("im.loading") : t("im.searchMore")}
                </Button>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
});
