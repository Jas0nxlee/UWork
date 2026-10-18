import { useCallback, useEffect, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImMessage } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

const DEBOUNCE_MS = 250;
const PAGE_SIZE = 30;

/**
 * 会话内检索的控制器。
 *
 * 关键判断：**搜服务端的整段历史**，不是"在已加载的那一页里过滤"。
 * 后者在几百条之后就等于搜不到东西，却看起来像有搜索——那是更糟的"假功能"。
 * 命中列表按 seq 倒序（最近优先），可以继续往前翻（`before`）。
 */
export type ImSearchScope = "conversation" | "all";

export interface ImSearchController {
  query: string;
  setQuery: (value: string) => void;
  results: ImMessage[];
  hasMore: boolean;
  searching: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  reset: () => void;
  /** 全局检索时：命中所在会话的信息（列表要显示"来自哪个会话"）。 */
  conversations: Record<string, { title: string | null; kind: "dm" | "group" | "channel" }>;
}

export function useImSearch(
  service: IImService | null,
  conversationId: string | null,
  enabled: boolean,
  scope: ImSearchScope = "conversation",
): ImSearchController {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ImMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<
    Record<string, { title: string | null; kind: "dm" | "group" | "channel" }>
  >({});

  const reset = useCallback(() => {
    setQuery("");
    setResults([]);
    setHasMore(false);
    setError(null);
    setSearching(false);
    setConversations({});
  }, []);

  // 换会话就把结果收起来。
  useEffect(() => {
    reset();
  }, [conversationId, reset]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !service || !conversationId || !trimmed) {
      setResults([]);
      setHasMore(false);
      setError(null);
      setSearching(false);
      setConversations({});
      return;
    }
    let active = true;
    setSearching(true);
    setError(null);
    // 防抖：每敲一个字打一次服务端，是拿网络换噪声。
    const timer = window.setTimeout(() => {
      // 作用域只是"搜哪里"：单会话走 searchMessages，全局走 searchAllMessages，
      // 其余（防抖、分页、错误、结果列表）完全共用。
      const request =
        scope === "all"
          ? service.searchAllMessages({ query: trimmed, limit: PAGE_SIZE }).then((page) => ({
              messages: page.messages,
              hasMore: page.hasMore,
              conversations: page.conversations,
            }))
          : service
              .searchMessages({ conversationId, query: trimmed, limit: PAGE_SIZE })
              .then((page) => ({
                messages: page.messages,
                hasMore: page.hasMore,
                conversations: {},
              }));
      void request
        .then((page) => {
          if (!active) return;
          setResults(page.messages);
          setHasMore(page.hasMore);
          setConversations(page.conversations);
        })
        .catch((caught: unknown) => {
          logger.warn("[im] 检索失败", caught);
          if (active) setError(intl.formatMessage({ id: "im.searchFailed" }));
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [enabled, query, service, conversationId, intl, scope]);

  const loadMore = useCallback(() => {
    const oldest = results[results.length - 1];
    if (!service || !conversationId || !oldest) return;
    setLoadingMore(true);
    const request =
      scope === "all"
        ? service
            .searchAllMessages({ query: query.trim(), before: oldest.seq, limit: PAGE_SIZE })
            .then((page) => ({ messages: page.messages, hasMore: page.hasMore }))
        : service
            .searchMessages({
              conversationId,
              query: query.trim(),
              before: oldest.seq,
              limit: PAGE_SIZE,
            })
            .then((page) => ({ messages: page.messages, hasMore: page.hasMore }));
    void request
      .then((page) => {
        setResults((current) => [...current, ...page.messages]);
        setHasMore(page.hasMore);
      })
      .catch((caught: unknown) => logger.warn("[im] 检索翻页失败", caught))
      .finally(() => setLoadingMore(false));
  }, [results, service, conversationId, query, scope]);

  return {
    query,
    setQuery,
    results,
    hasMore,
    searching,
    loadingMore,
    error,
    loadMore,
    reset,
    conversations,
  };
}
