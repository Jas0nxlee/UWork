/**
 * 通知与角标要跨组件协作，所以状态放一个小 store 里，而不是层层传参：
 * - 面板告诉它"我现在在看哪个会话"（在看的会话不弹通知）；
 * - 通知点击/角标清零要能反向驱动界面（打开某个会话）。
 *
 * 用模块级 store 是因为侧栏页脚（角标）、消息面板（当前会话）、通知（点开跳转）
 * 分处三棵互不相邻的子树。
 */
type Listener = (state: {
  activeConversationId: string | null;
  openRequest: string | null;
}) => void;

let activeConversationId: string | null = null;
/** 会话显示名（列表里那一行叫什么）：通知标题要用它，单聊就是对方的名字。 */
let conversationTitles: Record<string, string> = {};
let openRequest: string | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener({ activeConversationId, openRequest });
}

export function setActiveImConversation(conversationId: string | null): void {
  if (activeConversationId === conversationId) return;
  activeConversationId = conversationId;
  emit();
}

/** 面板算出显示名后推过来（它才知道单聊对面是谁）。 */
export function setImConversationTitles(titles: Record<string, string>): void {
  conversationTitles = titles;
}

export function getImConversationTitle(conversationId: string): string | undefined {
  return conversationTitles[conversationId];
}

export function getActiveImConversation(): string | null {
  return activeConversationId;
}

/** 请求打开某个会话（点通知时用）；面板消费后要调 clearImOpenRequest。 */
export function requestOpenImConversation(conversationId: string): void {
  openRequest = conversationId;
  emit();
}

export function clearImOpenRequest(): void {
  if (openRequest === null) return;
  openRequest = null;
  emit();
}

export function subscribeImNotificationState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getImNotificationState(): {
  activeConversationId: string | null;
  openRequest: string | null;
} {
  return { activeConversationId, openRequest };
}
