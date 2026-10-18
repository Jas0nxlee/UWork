/**
 * 会话级偏好：置顶与静音。
 *
 * 两条判断：
 * 1. **这是纯客户端偏好，不入库**。它不是团队事实（不该被别人看见），也不是权限——
 *    服务端多一张表只会多一份要治理的数据。放 localStorage，键按用户 id 分隔由调用方保证。
 * 2. **静音不等于隐藏**。成熟 IM 的语义是：会话还在列表里、还能置顶，但不再计数进总角标，
 *    未读从"数字"降级成"圆点"——用户要的是"别打扰我"，不是"我看不到了"。
 */
import { useSyncExternalStore } from "react";
import type { ImConversationSummary } from "@zcode/shared";

export interface ImConversationPreference {
  pinned: boolean;
  muted: boolean;
}

export type ImPreferenceMap = Record<string, ImConversationPreference>;

export const IM_PREFERENCES_STORAGE_KEY = "uwork:im-prefs";

const EMPTY: ImConversationPreference = { pinned: false, muted: false };

export function parseImPreferences(raw: string | null | undefined): ImPreferenceMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const result: ImPreferenceMap = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { pinned?: unknown; muted?: unknown };
    const pinned = entry.pinned === true;
    const muted = entry.muted === true;
    if (pinned || muted) result[id] = { pinned, muted };
  }
  return result;
}

export function serializeImPreferences(preferences: ImPreferenceMap): string {
  return JSON.stringify(preferences);
}

export function preferenceOf(
  preferences: ImPreferenceMap,
  conversationId: string,
): ImConversationPreference {
  return preferences[conversationId] ?? EMPTY;
}

/** 置顶/静音开关。两个都关掉时把这一项删掉，存储不留下无意义的空壳。 */
export function togglePreference(
  preferences: ImPreferenceMap,
  conversationId: string,
  key: "pinned" | "muted",
): ImPreferenceMap {
  const current = preferenceOf(preferences, conversationId);
  const next = { ...current, [key]: !current[key] };
  const result = { ...preferences };
  if (!next.pinned && !next.muted) delete result[conversationId];
  else result[conversationId] = next;
  return result;
}

/** 排序：置顶优先，其余按最后活动时间倒序（服务端也是这个顺序，这里只是让置顶生效）。 */
export function applyConversationPreferences(
  conversations: readonly ImConversationSummary[],
  preferences: ImPreferenceMap,
): ImConversationSummary[] {
  return [...conversations].sort((a, b) => {
    const pinnedA = preferenceOf(preferences, a.id).pinned ? 1 : 0;
    const pinnedB = preferenceOf(preferences, b.id).pinned ? 1 : 0;
    if (pinnedA !== pinnedB) return pinnedB - pinnedA;
    return b.updatedAt - a.updatedAt;
  });
}

/** 侧栏角标总数：静音的会话不计入（否则"静音"对总角标毫无作用）。 */
export function sumUnread(
  conversations: readonly ImConversationSummary[],
  preferences: ImPreferenceMap,
): number {
  return conversations.reduce((total, conversation) => {
    if (preferenceOf(preferences, conversation.id).muted) return total;
    return total + conversation.unreadCount;
  }, 0);
}

function readStorage(): ImPreferenceMap {
  if (typeof localStorage === "undefined") return {};
  try {
    return parseImPreferences(localStorage.getItem(IM_PREFERENCES_STORAGE_KEY));
  } catch {
    // 存储被禁用（隐私模式）或实现不完整时按"没有偏好"处理，不能因此让面板打不开。
    return {};
  }
}

// 会话列表与侧栏角标是两棵子树里的组件，偏好要共享同一份快照，用一个小 store 而不是层层传参。
let snapshot: ImPreferenceMap | null = null;
const listeners = new Set<() => void>();

export function readImPreferences(): ImPreferenceMap {
  snapshot ??= readStorage();
  return snapshot;
}

export function writeImPreferences(next: ImPreferenceMap): void {
  snapshot = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(IM_PREFERENCES_STORAGE_KEY, serializeImPreferences(next));
    } catch {
      // 存不下就只留在内存里：偏好丢了是小事，操作抛错是大事。
    }
  }
  for (const listener of listeners) listener();
}

export function subscribeImPreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useImPreferences(): {
  preferences: ImPreferenceMap;
  toggle: (conversationId: string, key: "pinned" | "muted") => void;
} {
  const preferences = useSyncExternalStore(
    subscribeImPreferences,
    readImPreferences,
    readImPreferences,
  );
  return {
    preferences,
    toggle: (conversationId, key) =>
      writeImPreferences(togglePreference(readImPreferences(), conversationId, key)),
  };
}
