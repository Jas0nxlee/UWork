// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseImCard, type ImCardDocument } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImCardRenderer } from "@/im/ImCardRenderer.js";

/**
 * 通用卡片渲染器的**协议边界测试**。
 *
 * 这套架构能不能站住，取决于"遇到不认识的东西会怎样"：
 * - 缺 fallback / 缺 type / JSON 坏了 → 退化成提示文本，**绝不能空白或甩一串 JSON**；
 * - 未知 section → 跳过（前向兼容：服务端先上新原语，老客户端照旧能用）；
 * - 未知 type/version → 仍然按原语渲染（类型只是标签，不是分支）。
 */
const doc = (over: Partial<ImCardDocument> = {}): string =>
  JSON.stringify({
    card: { version: 1, type: "reports.work_report" },
    fallback: "[汇报] 2026-W42 本周实验记录汇总 · 问题：样本量不足",
    title: "本周实验记录汇总",
    subtitle: "2026-W42",
    badges: [{ text: "有问题", tone: "warning" }],
    sections: [
      { kind: "text", label: "做了什么", text: "三组对照实验" },
      { kind: "text", label: "遇到的问题", text: "样本量不足", tone: "danger" },
      { kind: "fields", fields: [{ label: "样本量", value: "12" }] },
      { kind: "list", items: ["记录A.xlsx", "记录B.xlsx"] },
      { kind: "divider" },
      { kind: "progress", label: "完成度", value: 3, max: 5 },
    ],
    attachments: [{ id: "att-1", name: "记录A.xlsx", mime: "application/vnd.ms-excel", size: 10 }],
    actions: [
      { id: "open", label: "查看详情", kind: "client", target: "reports.work_report:r-1" },
      { id: "review", label: "已阅", kind: "server" },
    ],
    ...over,
  });

const renderCard = (body: string, onAction?: (action: { id: string; target?: string }) => void) =>
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ImCardRenderer, {
        body,
        authorLabel: "辛晓华",
        ...(onAction ? { onAction } : {}),
      }),
    ),
  );

afterEach(cleanup);

describe("通用卡片渲染器", () => {
  it("按原语渲染：标题/徽标/段落/字段/列表/进度/附件/动作", () => {
    const { container } = renderCard(doc());
    const card = container.querySelector('[data-testid="im-card"]');
    expect(card?.getAttribute("data-card-type")).toBe("reports.work_report");
    expect(card?.textContent).toContain("本周实验记录汇总");
    expect(card?.textContent).toContain("2026-W42");
    expect(screen.getByTestId("im-card-badge").textContent).toBe("有问题");
    expect(card?.textContent).toContain("三组对照实验");
    expect(card?.textContent).toContain("样本量不足");
    expect(card?.textContent).toContain("样本量"); // fields
    expect(card?.textContent).toContain("记录B.xlsx"); // list + attachments
    expect(card?.textContent).toContain("60%"); // progress 3/5
    expect(card?.textContent).toContain("辛晓华"); // 作者（渲染器补，服务端不存姓名）
    const actions = [...container.querySelectorAll('[data-testid="im-card-action"]')];
    expect(actions.map((item) => item.getAttribute("data-card-action"))).toEqual([
      "open",
      "review",
    ]);
    expect(actions.map((item) => item.getAttribute("data-card-action-kind"))).toEqual([
      "client",
      "server",
    ]);
  });

  it("client 动作把 id、kind 与 target 交给外层（渲染器不判权限、不认业务 id 的含义）", () => {
    const onAction = vi.fn();
    const { container } = renderCard(doc(), onAction);
    const open = container.querySelector('[data-card-action="open"]') as HTMLButtonElement;
    fireEvent.click(open);
    // `kind` 必须一起交出去：外层靠它分派"界面动作"还是"调服务端"（§12.18），
    // 否则又得从 target 猜业务语义。第二个参数是整份文档（外层要知道"这是哪种卡片"）。
    expect(onAction).toHaveBeenCalledWith(
      { id: "open", kind: "client", target: "reports.work_report:r-1" },
      expect.objectContaining({ card: { version: 1, type: "reports.work_report" } }),
    );
  });

  it("未知 section 跳过，已认识的照常渲染（前向兼容）", () => {
    const { container } = renderCard(
      doc({
        sections: [
          { kind: "text", text: "认识的" },
          { kind: "chart", spec: "未来的原语" } as never,
        ],
      }),
    );
    const card = container.querySelector('[data-testid="im-card"]');
    expect(card?.textContent).toContain("认识的");
    expect(card?.textContent).not.toContain("未来的原语");
  });

  it("未知 card.type/version 仍然按原语渲染（类型只是标签，不是渲染分支）", () => {
    const { container } = renderCard(
      doc({ card: { version: 9, type: "testing.something_new" }, title: "新类型" }),
    );
    const card = container.querySelector('[data-testid="im-card"]');
    expect(card?.getAttribute("data-card-type")).toBe("testing.something_new");
    expect(card?.textContent).toContain("新类型");
  });

  it("缺 fallback / 缺 type / 坏 JSON → 退化成提示文本，不空白也不甩 JSON", () => {
    for (const body of [
      '{"card":{"version":1,"type":"x"},"title":"没有 fallback"}',
      '{"fallback":"有 fallback 但没 type","title":"x"}',
      "{ 这不是 JSON",
    ]) {
      const { container, unmount } = renderCard(body);
      expect(container.querySelector('[data-testid="im-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="im-card-fallback"]')?.textContent).toBeTruthy();
      expect(container.textContent).not.toContain("card");
      unmount();
    }
  });
});

describe("卡片文档解析", () => {
  it("fallback 与 type 是硬要求", () => {
    expect(parseImCard('{"card":{"version":1,"type":"a"},"fallback":"f"}')).not.toBeNull();
    expect(parseImCard('{"card":{"version":1},"fallback":"f"}')).toBeNull();
    expect(parseImCard('{"card":{"version":1,"type":"a"},"fallback":"  "}')).toBeNull();
    expect(parseImCard('{"card":{"type":"a"},"fallback":"f"}')).toBeNull();
  });

  it("认不出的 section / 动作 kind 被丢掉，而不是让渲染器去猜", () => {
    const parsed = parseImCard(
      JSON.stringify({
        card: { version: 1, type: "a" },
        fallback: "f",
        sections: [{ kind: "chart" }, { kind: "text", text: "ok" }],
        actions: [
          { id: "x", label: "X", kind: "evil" },
          { id: "y", label: "Y", kind: "client" },
        ],
      }),
    );
    expect(parsed?.sections).toEqual([{ kind: "text", text: "ok" }]);
    expect(parsed?.actions?.map((action) => action.id)).toEqual(["y"]);
  });
});
