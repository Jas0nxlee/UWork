// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IImService } from "@zcode/services";
import type { ImMember, ImMessage } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImConversationPanel } from "@/im/ImConversationPanel.js";

/**
 * @提及的**端到端接线**测试：从输入框里敲 "@" 选候选，一路走到 service.sendMessage。
 *
 * 为什么必须从这一层测：@ 有两条独立的链路——正文里的 "@名字"（本地渲染高亮）和
 * `mentionIds`（服务端据此算"提到我"）。两者任缺一条，界面看起来都"有 @"，
 * 但收方的提及永远不会亮。曾经就漏在中间一层（面板把 onSubmit 的参数吞了），
 * 只在真机联调时才被发现；这一条把它钉在单测里。
 */

const SELF = "u-me";
const PEER = "u-lv";

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m1",
  conversationId: "c1",
  seq: 1,
  senderId: SELF,
  kind: "text",
  body: "早",
  clientMsgId: null,
  createdAt: new Date("2026-10-18T10:00:00+08:00").getTime(),
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  reactions: [],
  ...over,
});

const member = (id: string, role: "owner" | "member"): ImMember => ({
  id,
  role,
  joinedAt: 0,
  online: true,
});

/** 只桩掉面板真正会调到的那几个方法；其余一律给一个"什么都不做"的异步函数。 */
function serviceStub(): IImService {
  const sendMessage = vi.fn(async (input: { body: string }) =>
    message({ id: "m-sent", seq: 2, senderId: SELF, body: input.body }),
  );
  const base: Record<string, unknown> = {
    openConversation: vi.fn(async () => ({ conversationId: "c1", messages: [], hasMore: false })),
    pinnedMessages: vi.fn(async () => []),
    onRealtime: vi.fn(() => ({ dispose: () => undefined })),
    markRead: vi.fn(async () => 0),
    sendTyping: vi.fn(),
    sendMessage,
  };
  const proxy = new Proxy(base, {
    get: (target, key) =>
      typeof key === "string" && key in target ? target[key] : vi.fn(async () => undefined),
  });
  return proxy as unknown as IImService;
}

afterEach(cleanup);

beforeAll(() => {
  // 面板挂载时会量宽度（Radix 也用量尺寸的 ResizeObserver），jsdom 没有这两个 API。
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // 这个 jsdom 环境里的 localStorage 是个没有方法的空对象，草稿读写需要一个真的 Storage。
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
});

const renderPanel = (service: IImService) =>
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ImConversationPanel, {
        service,
        conversationId: "c1",
        selfUserId: SELF,
        title: "项目组",
        nameOf: (id: string) => (id === PEER ? "吕岳阳" : id),
        initialLastReadSeq: 0,
        conversations: [],
        directory: [],
        members: [member(SELF, "owner"), member(PEER, "member")],
        bookmarkedIds: new Set<string>(),
        onToggleBookmark: () => undefined,
        onForwardMessage: () => undefined,
      }),
    ),
  );

describe("@提及从输入框到服务的接线", () => {
  it("敲 @ 选候选后发送：正文带 @名字，mentionIds 也带上（不是只有文字）", async () => {
    const service = serviceStub();
    const { container } = renderPanel(service);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "@" } });
    await waitFor(() => expect(screen.queryByTestId("im-mention-picker")).toBeTruthy());

    // 候选里的回车是"选第一个人"，不是发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe("@全体 "));
    expect(screen.queryByTestId("im-mention-picker")).toBeNull();

    fireEvent.change(textarea, { target: { value: "@全体 早上好" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(service.sendMessage).toHaveBeenCalledTimes(1));
    expect(service.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1", body: "@全体 早上好", mentionIds: ["all"] }),
    );
  });

  it("发之前把 @名字 删掉，就不再算一次提及", async () => {
    const service = serviceStub();
    const { container } = renderPanel(service);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@" } });
    await waitFor(() => expect(screen.queryByTestId("im-mention-picker")).toBeTruthy());
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toBe("@全体 "));

    // 手删掉 @全体：正文里没有了，服务端就不该收到这条提及
    fireEvent.change(textarea, { target: { value: "早上好" } });
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => expect(service.sendMessage).toHaveBeenCalledTimes(1));
    // 服务端只在有提及时才收到这个字段（空数组会让"提到我"的判定多绕一圈）
    const sent = (
      service.sendMessage as unknown as {
        mock: { calls: [{ body: string; mentionIds?: string[] }][] };
      }
    ).mock.calls[0]?.[0];
    expect(sent?.body).toBe("早上好");
    expect(sent?.mentionIds ?? []).toEqual([]);
  });
});
