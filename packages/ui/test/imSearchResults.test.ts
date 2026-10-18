// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ImMessage } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImSearchResults } from "@/im/ImSearchResults.js";

const message = (over: Partial<ImMessage> = {}): ImMessage => ({
  id: "m1",
  conversationId: "c1",
  seq: 1,
  senderId: "u-lv",
  kind: "text",
  body: "部署完成了",
  clientMsgId: null,
  createdAt: new Date("2026-10-18T10:00:00+08:00").getTime(),
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  reactions: [],
  ...over,
});

const renderResults = (overrides: Partial<Parameters<typeof ImSearchResults>[0]> = {}) =>
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ImSearchResults, {
        query: "部署",
        onQueryChange: () => undefined,
        results: [],
        searching: false,
        hasMore: false,
        loadingMore: false,
        error: null,
        senderNameOf: () => "吕岳阳",
        selfUserId: "u-me",
        onOpenHit: () => undefined,
        onLoadMore: () => undefined,
        onClose: () => undefined,
        ...overrides,
      }),
    ),
  );

afterEach(cleanup);

describe("检索结果列表", () => {
  it("每条命中给出发送者、时刻与高亮的正文片段", () => {
    const { container } = renderResults({
      results: [message({ id: "m-1", body: "第 240 条：部署完成" })],
    });
    const hit = container.querySelector('[data-testid="im-search-hit"]');
    expect(hit?.textContent).toContain("吕岳阳");
    expect(hit?.textContent).toContain("第 240 条：部署完成");
    expect(hit?.querySelector("mark")?.textContent).toBe("部署");
  });

  it("自己的消息显示成「你」", () => {
    const { container } = renderResults({
      results: [message({ id: "m-1", senderId: "u-me", body: "我发的部署说明" })],
    });
    expect(container.querySelector('[data-testid="im-search-hit"]')?.textContent).toContain("你");
  });

  it("点击命中把整条消息交给父组件（由它加载上下文并跳转）", () => {
    const onOpenHit = vi.fn();
    const target = message({ id: "m-9", seq: 15 });
    const { container } = renderResults({ results: [target], onOpenHit });
    (container.querySelector('[data-testid="im-search-hit"]') as HTMLButtonElement).click();
    expect(onOpenHit).toHaveBeenCalledWith(expect.objectContaining({ id: "m-9", seq: 15 }));
  });

  it("有更多结果时给「继续往前找」，并显示结果条数", () => {
    const { container } = renderResults({
      results: [message({ id: "m-1" })],
      hasMore: true,
    });
    expect(container.textContent).toContain("1 条结果");
    expect(container.textContent).toContain("继续往前找");
  });

  it("空查询提示搜的是全部历史；无命中与失败各有各的文案", () => {
    const empty = renderResults({ query: "" });
    expect(empty.container.textContent).toContain("在全部历史消息中搜索");
    empty.unmount();

    const noHit = renderResults({ query: "不存在的东西", results: [] });
    expect(noHit.container.textContent).toContain("无匹配");
    noHit.unmount();

    const failed = renderResults({ error: "搜索失败，请重试" });
    expect(failed.container.textContent).toContain("搜索失败");
  });
});
