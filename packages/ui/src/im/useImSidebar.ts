import { useEffect, useState } from "react";
import type { ImView } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { sumUnread, useImPreferences } from "./imPreferences.js";

/**
 * 侧栏入口的未读总数。
 *
 * 与面板里的 `useIm` 不同，这里**必须主动拉一次**：用户可能整个会话期都不打开消息面板，
 * 而角标要在那时就有意义（未读来自服务端视图，不是本地累加）。
 * 服务本身是宿主侧单例，连接与订阅在面板关闭后依然存在，所以这里订阅即可拿到后续增量。
 * 静音的会话不计入总数——否则"静音"对总角标毫无作用。
 */
export function useImUnread(): number {
  const services = useOptionalBaseWorkspaceServices();
  const service = services?.imService ?? null;
  const [view, setView] = useState<ImView | null>(null);
  const { preferences } = useImPreferences();

  useEffect(() => {
    if (!service) {
      setView(null);
      return;
    }
    let active = true;
    const apply = (candidate: unknown): void => {
      if (active) setView(candidate as ImView);
    };
    const subscription = service.onDidChange(apply);
    void service
      .getView()
      .then(apply)
      .catch(() => undefined);
    void service.refresh().catch((error: unknown) => {
      logger.warn("[im] 侧栏刷新失败", error);
    });
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [service]);

  const entitlement = view?.entitlement ?? null;
  // 明确没有权限才归零；"查不到"（网络失败）时保留上一次的角标，不要闪成 0。
  if (entitlement && !entitlement.enabled) return 0;
  return sumUnread(view?.conversations ?? [], preferences);
}
