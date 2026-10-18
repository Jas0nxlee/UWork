import { useCallback, useEffect, useState } from "react";
import type { IImService } from "@zcode/services";
import type { ImBookmarkItem } from "@zcode/shared";
import { logger } from "@/logger.js";

/**
 * 收藏。
 *
 * 两个判断：
 * 1. **这是"我的"数据，不是会话状态**——所以既不在消息里带标记，也不广播（别人不需要知道我收藏了什么）。
 *    本地维护一份 id 集合：右键菜单要立刻显示"收藏/取消收藏"，不能每次都回服务端问。
 * 2. 列表懒加载：只在真正打开收藏视图时拉全量（`items` 为空且未加载时才请求），
 *    否则每次进面板都要多打一次接口。
 */
export function useImBookmarks(service: IImService | null): {
  ids: ReadonlySet<string>;
  items: ImBookmarkItem[];
  loaded: boolean;
  toggle: (messageId: string, bookmarked: boolean) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [items, setItems] = useState<ImBookmarkItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!service) return;
    try {
      const list = await service.listBookmarks();
      setItems(list);
      setIds(new Set(list.map((item) => item.message.id)));
      setLoaded(true);
    } catch (error) {
      logger.warn("[im] 读取收藏失败", error);
    }
  }, [service]);

  useEffect(() => {
    if (!service) {
      setIds(new Set());
      setItems([]);
      setLoaded(false);
      return;
    }
    void refresh();
  }, [service, refresh]);

  const toggle = useCallback(
    async (messageId: string, bookmarked: boolean): Promise<void> => {
      if (!service) return;
      // 先改本地（右键菜单立刻反馈），失败再回滚——收藏是低风险操作，不值得等一个往返。
      setIds((current) => {
        const next = new Set(current);
        if (bookmarked) next.add(messageId);
        else next.delete(messageId);
        return next;
      });
      try {
        await service.setBookmark({ messageId, bookmarked });
        if (loaded) await refresh();
      } catch (error) {
        logger.warn("[im] 收藏操作失败", error);
        setIds((current) => {
          const next = new Set(current);
          if (bookmarked) next.delete(messageId);
          else next.add(messageId);
          return next;
        });
      }
    },
    [service, loaded, refresh],
  );

  return { ids, items, loaded, toggle, refresh };
}
