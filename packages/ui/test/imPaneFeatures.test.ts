// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ImConversationSummary, ImDirectoryUser, ImMessage } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImConversationList } from "@/im/ImConversationList.js";
import { ImTimeline } from "@/im/ImTimeline.js";
import { writeImPreferences } from "@/im/imPreferences.js";
import type { ImOutboxItem } from "@/im/imOutbox.js";
import type { ImTimelineRow } from "@/im/imPresentation.js";
import { buildTimeline } from "@/im/imPresentation.js";

const NOW = new Date("2026-10-18T10:00:00+08:00").getTime();
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const conversation = (over: Partial<ImConversationSummary> = {}): ImConversationSummary => ({
  id: "c1",
  orgId: "org",
  kind: "group",
  title: "项目组",
  createdBy: "u-me",
  dmKey: null,
  lastSeq: 1,
  createdAt: NOW,
  updatedAt: NOW,
  lastReadSeq: 0,
  unreadCount: 0,
  lastMessage: null,
  ...over,
});

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m1",
  conversationId: "c1",
  seq: 1,
  senderId: "u-me",
  kind: "text",
  body: "部署失败了，看一下",
  clientMsgId: null,
  createdAt: NOW,
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  reactions: [],
  ...over,
});

const directory: ImDirectoryUser[] = [
  {
    id: "u-me",
    name: "辛晓华",
    avatar: null,
    department: "测试与服务保障部",
    departments: ["测试与服务保障部"],
    position: null,
  },
];

const renderWithIntl = (element: ReturnType<typeof createElement>) =>
  render(createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, element));

const listProps = {
  directory,
  selfUserId: "u-me",
  selectedId: null,
  onSelect: () => undefined,
};

beforeEach(() => {
  // store 的缓存快照必须走 writeImPreferences 更新，直接写 localStorage 不会生效。
  writeImPreferences({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("会话列表：置顶与静音", () => {
  it("置顶的会话排到最前，并带出置顶标记", () => {
    writeImPreferences({ "c-old": { pinned: true, muted: false } });
    const { container } = renderWithIntl(
      createElement(ImConversationList, {
        ...listProps,
        conversations: [
          conversation({ id: "c-new", title: "新消息", updatedAt: NOW + 1000 }),
          conversation({ id: "c-old", title: "老会话", updatedAt: NOW }),
        ],
      }),
    );
    const titles = [...container.querySelectorAll('[data-testid="im-conversation-row"]')].map(
      (row) => row.textContent,
    );
    expect(titles[0]).toContain("老会话");
    expect(titles[1]).toContain("新消息");
    expect(container.querySelector("svg.lucide-pin")).not.toBeNull();
  });

  it("静音的会话未读只给圆点，不给数字", () => {
    writeImPreferences({ "c-muted": { pinned: false, muted: true } });
    const { container } = renderWithIntl(
      createElement(ImConversationList, {
        ...listProps,
        conversations: [
          conversation({ id: "c-muted", title: "免打扰", unreadCount: 7 }),
          conversation({ id: "c-loud", title: "正常", unreadCount: 3, updatedAt: NOW - 1000 }),
        ],
      }),
    );
    const mutedRow = container.querySelector('[data-testid="im-conversation-muted-icon"]');
    expect(mutedRow).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="im-conversation-muted-dot"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="im-conversation-unread"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="im-conversation-unread"]')?.textContent).toBe(
      "3",
    );
  });
});

describe("消息列：搜索命中与本地乐观消息", () => {
  const rows = (messages: ImMessage[]): ImTimelineRow[] =>
    buildTimeline({
      messages,
      selfUserId: "u-me",
      now: NOW,
      dayLabels: {
        today: "今天",
        yesterday: "昨天",
        weekdays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
      },
    });

  const timelineProps = {
    selfLabel: "辛晓华（你）",
    senderNameOf: () => "辛晓华",
    query: "",
    activeMessageId: null,
    confirmingId: null,
    onWithdraw: () => undefined,
    onReply: () => undefined,
    onForward: () => undefined,
    onJumpToMessage: () => undefined,
    onRetryOutbox: () => undefined,
    onDiscardOutbox: () => undefined,
  };

  it("有查询时命中处套 mark，当前命中整行高亮", () => {
    const target = message({ id: "m-hit", body: "部署失败了，重新部署一次" });
    const { container } = renderWithIntl(
      createElement(ImTimeline, {
        ...timelineProps,
        rows: rows([target]),
        outbox: [],
        query: "部署",
        activeMessageId: "m-hit",
      }),
    );
    const marks = [...container.querySelectorAll("mark")].map((node) => node.textContent);
    expect(marks).toEqual(["部署", "部署"]);
    const row = container.querySelector('[data-im-message-id="m-hit"]');
    expect(row?.className).toContain("ring-1");
  });

  it("没查询时正文原样输出，不加高亮节点", () => {
    const { container } = renderWithIntl(
      createElement(ImTimeline, {
        ...timelineProps,
        rows: rows([message({ body: "普通消息" })]),
        outbox: [],
      }),
    );
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toContain("普通消息");
  });

  it("发送中/失败两种乐观消息：失败给重试与删除", () => {
    const sending: ImOutboxItem = {
      clientMsgId: "local-1",
      conversationId: "c1",
      body: "正在发",
      createdAt: NOW,
      status: "sending",
    };
    const failed: ImOutboxItem = {
      ...sending,
      clientMsgId: "local-2",
      body: "没发出去",
      status: "failed",
    };
    const onRetryOutbox = vi.fn();
    const onDiscardOutbox = vi.fn();
    const { container } = renderWithIntl(
      createElement(ImTimeline, {
        ...timelineProps,
        rows: [],
        outbox: [sending, failed],
        onRetryOutbox,
        onDiscardOutbox,
      }),
    );
    expect(
      container
        .querySelector('[data-im-outbox-id="local-1"]')
        ?.getAttribute("data-im-outbox-status"),
    ).toBe("sending");
    const failedRow = container.querySelector('[data-im-outbox-id="local-2"]');
    expect(failedRow?.textContent).toContain("发送失败");
    const buttons = [...(failedRow?.querySelectorAll("button") ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual(["重试", "删除"]);
    buttons[0]?.click();
    buttons[1]?.click();
    expect(onRetryOutbox).toHaveBeenCalledWith("local-2");
    expect(onDiscardOutbox).toHaveBeenCalledWith("local-2");
  });
});

describe("消息行：引用块 / 工具条 / 系统消息", () => {
  const rows = (messages: ImMessage[]): ImTimelineRow[] =>
    buildTimeline({
      messages,
      selfUserId: "u-me",
      now: NOW,
      dayLabels: { today: "今天", yesterday: "昨天", weekdays: WEEKDAYS },
    });
  const baseProps = {
    service: null,
    selfUserId: "u-me",
    onToggleReaction: () => undefined,
    outbox: [] as never[],
    selfLabel: "辛晓华（你）",
    senderNameOf: (id: string) => (id === "u-me" ? "辛晓华" : "吕岳阳"),
    query: "",
    activeMessageId: null,
    confirmingId: null,
    onWithdraw: () => undefined,
    onReply: () => undefined,
    onForward: () => undefined,
    onJumpToMessage: () => undefined,
    onRetryOutbox: () => undefined,
    onDiscardOutbox: () => undefined,
  };

  it("引用块显示被引用者与摘要，点击回调带出目标 id", () => {
    const onJumpToMessage = vi.fn();
    const target = message({ id: "m-1", senderId: "u-lv", body: "原始问题" });
    const reply = message({
      id: "m-2",
      seq: 2,
      senderId: "u-me",
      body: "回答",
      createdAt: NOW + 60_000,
      replyTo: {
        messageId: "m-1",
        senderId: "u-lv",
        body: "原始问题",
        kind: "text",
        deleted: false,
      },
    });
    const { container } = renderWithIntl(
      createElement(ImTimeline, { ...baseProps, rows: rows([target, reply]), onJumpToMessage }),
    );
    const quote = container.querySelector('[data-im-reply-target="m-1"]');
    expect(quote?.textContent).toContain("吕岳阳");
    expect(quote?.textContent).toContain("原始问题");
    (quote as HTMLButtonElement).click();
    expect(onJumpToMessage).toHaveBeenCalledWith("m-1");
  });

  it("引用已撤回的消息时只显示「已撤回」，不泄露正文", () => {
    const reply = message({
      id: "m-2",
      senderId: "u-me",
      replyTo: {
        messageId: "m-1",
        senderId: "u-lv",
        body: "",
        kind: "text",
        deleted: true,
      },
    });
    const { container } = renderWithIntl(
      createElement(ImTimeline, { ...baseProps, rows: rows([reply]) }),
    );
    const quote = container.querySelector('[data-im-reply-target="m-1"]');
    expect(quote?.textContent).toContain("消息已撤回");
  });

  it("工具条给表情/回复/转发/复制，自己的消息多一个撤回", () => {
    const theirs = message({ id: "m-1", senderId: "u-lv", body: "别人的" });
    const mine = message({
      id: "m-2",
      seq: 2,
      senderId: "u-me",
      body: "我的",
      createdAt: NOW + 60_000,
    });
    const { container } = renderWithIntl(
      createElement(ImTimeline, { ...baseProps, rows: rows([theirs, mine]) }),
    );
    const toolbars = [...container.querySelectorAll('[data-im-message-toolbar="true"]')];
    expect(toolbars).toHaveLength(2);
    // 表情是图标按钮（用 aria-label 认），其余是文字按钮；撤回只出现在自己的消息上
    expect(toolbars[0]?.querySelector('button[aria-label="添加表情"]')).not.toBeNull();
    expect(toolbars[0]?.textContent).toBe("回复转发复制");
    expect(toolbars[1]?.textContent).toBe("回复转发复制撤回");
  });

  it("系统消息渲染成全宽提示行，且不参与连续消息合并", () => {
    const before = message({ id: "m-1", senderId: "u-lv", body: "前一条" });
    const system = message({
      id: "m-2",
      seq: 2,
      senderId: "u-me",
      kind: "system",
      body: JSON.stringify({ action: "title_changed", actorId: "u-me", title: "新群名" }),
      createdAt: NOW + 60_000,
    });
    const after = message({
      id: "m-3",
      seq: 3,
      senderId: "u-lv",
      body: "后一条",
      createdAt: NOW + 120_000,
    });
    const { container } = renderWithIntl(
      createElement(ImTimeline, { ...baseProps, rows: rows([before, system, after]) }),
    );
    const systemRow = container.querySelector('[data-im-system-message="true"]');
    expect(systemRow?.textContent).toContain("把群名改成了「新群名」");
    // 系统消息前后的两条不能因为"同一发送者"被合并掉头像（分组被打断）
    expect(container.querySelectorAll('[data-im-message-toolbar="true"]')).toHaveLength(2);
  });
});

describe("会话列表：分组标题", () => {
  it("按置顶/单聊/群聊分组，搜索时不分", () => {
    writeImPreferences({ "g-1": { pinned: true, muted: false } });
    const { container } = renderWithIntl(
      createElement(ImConversationList, {
        ...listProps,
        conversations: [
          conversation({ id: "g-1", title: "被置顶", kind: "group" }),
          conversation({ id: "d-1", title: "某人", kind: "dm", dmKey: "u-me:u-other" }),
          conversation({ id: "g-2", title: "普通群", kind: "group", updatedAt: NOW - 1000 }),
        ],
      }),
    );
    const groups = [...container.querySelectorAll('[data-testid="im-conversation-group"]')].map(
      (node) => node.textContent,
    );
    expect(groups).toEqual(["置顶", "单聊", "群聊"]);
  });
});

describe("表情回应与附件", () => {
  const rowsOf = (messages: ImMessage[]): ImTimelineRow[] =>
    buildTimeline({
      messages,
      selfUserId: "u-me",
      now: NOW,
      dayLabels: { today: "今天", yesterday: "昨天", weekdays: WEEKDAYS },
    });
  const props = {
    outbox: [] as never[],
    selfLabel: "辛晓华（你）",
    senderNameOf: () => "吕岳阳",
    query: "",
    activeMessageId: null,
    confirmingId: null,
    onWithdraw: () => undefined,
    onReply: () => undefined,
    onForward: () => undefined,
    onJumpToMessage: () => undefined,
    onRetryOutbox: () => undefined,
    onDiscardOutbox: () => undefined,
    service: null,
    selfUserId: "u-me",
    onToggleReaction: () => undefined,
  };

  it("回应 chip 显示表情与人数，自己点过的高亮，点击回调带出当前状态", () => {
    const onToggleReaction = vi.fn();
    const reacted = message({
      id: "m-1",
      senderId: "u-lv",
      body: "上线了吗",
      reactions: [
        { emoji: "👍", count: 2, userIds: ["u-lv", "u-me"] },
        { emoji: "🎉", count: 1, userIds: ["u-lv"] },
      ],
    });
    const { container } = renderWithIntl(
      createElement(ImTimeline, { ...props, rows: rowsOf([reacted]), onToggleReaction }),
    );
    const chips = [...container.querySelectorAll('[data-testid="im-reaction-chip"]')];
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe("👍2");
    expect(chips[0]?.getAttribute("data-reaction-mine")).toBe("true");
    expect(chips[1]?.getAttribute("data-reaction-mine")).toBe("false");

    (chips[0] as HTMLButtonElement).click();
    // 我点过 → 点击是取消
    expect(onToggleReaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m-1" }),
      "👍",
      true,
    );
  });

  it("附件消息不渲染正文，图片内联、文件给卡片", () => {
    const imageMessage = message({
      id: "m-img",
      senderId: "u-lv",
      kind: "attachment",
      body: JSON.stringify({
        attachmentId: "a-1",
        name: "截图.png",
        mime: "image/png",
        size: 2048,
      }),
    });
    const fileMessage = message({
      id: "m-file",
      seq: 2,
      senderId: "u-lv",
      kind: "attachment",
      createdAt: NOW + 1000,
      body: JSON.stringify({
        attachmentId: "a-2",
        name: "报告.pdf",
        mime: "application/pdf",
        size: 1024 * 1024 * 3,
      }),
    });
    const { container } = renderWithIntl(
      createElement(ImTimeline, { ...props, rows: rowsOf([imageMessage, fileMessage]) }),
    );
    // 图片分支：没有 service 时停在"加载中"，也不该把 JSON 当正文画出来
    expect(container.textContent).not.toContain("attachmentId");
    expect(container.textContent).toContain("截图.png");
    const file = container.querySelector('[data-testid="im-attachment-file"]');
    expect(file?.textContent).toContain("报告.pdf");
    expect(file?.textContent).toContain("3.0 MB");
  });

  it("载荷坏掉的附件消息给一句提示，不静默消失", () => {
    const broken = message({
      id: "m-x",
      kind: "attachment",
      senderId: "u-lv",
      body: "{not json",
    });
    const { container } = renderWithIntl(
      createElement(ImTimeline, { ...props, rows: rowsOf([broken]) }),
    );
    expect(container.textContent).toContain("这条附件消息无法解析");
  });
});

describe("会话列表预览", () => {
  it("系统消息预览渲染成人话，不漏 JSON 载荷", () => {
    const { container } = renderWithIntl(
      createElement(ImConversationList, {
        ...listProps,
        onNewConversation: () => undefined,
        onRefresh: () => undefined,
        conversations: [
          conversation({
            id: "g-1",
            title: "联调测试群",
            lastMessage: message({
              kind: "system",
              body: JSON.stringify({
                action: "title_changed",
                actorId: "u-lv",
                title: "新名字",
              }),
            }),
          }),
        ],
      }),
    );
    const row = container.querySelector('[data-testid="im-conversation-row"]');
    expect(row?.textContent).toContain("把群名改成了「新名字」");
    expect(row?.textContent).not.toContain("{");
  });

  it("附件消息预览给类型与文件名，自己的带「你」前缀", () => {
    const { container } = renderWithIntl(
      createElement(ImConversationList, {
        ...listProps,
        onNewConversation: () => undefined,
        onRefresh: () => undefined,
        conversations: [
          conversation({
            id: "c-img",
            title: "某人",
            kind: "dm",
            dmKey: "u-me:u-other",
            lastMessage: message({
              kind: "attachment",
              senderId: "u-me",
              body: JSON.stringify({
                attachmentId: "a-1",
                name: "截图.png",
                mime: "image/png",
                size: 100,
              }),
            }),
          }),
        ],
      }),
    );
    const row = container.querySelector('[data-testid="im-conversation-row"]');
    expect(row?.textContent).toContain("[图片] 截图.png");
    expect(row?.textContent).toContain("你");
  });
});
