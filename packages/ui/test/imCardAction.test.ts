// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import type { IImService } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImCardRenderer } from "@/im/ImCardRenderer.js";
import { ImCardReturnDialog } from "@/im/ImCardReturnDialog.js";
import { imCardViewerRole, resolveImCardAction } from "@/im/imPresentation.js";
import { parseImCard } from "@zcode/shared";
import { useImCardActionDispatch } from "@/im/useImCardActionDispatch.js";
import { ImHttpError } from "../../services/src/im/imHttpClient.js";

/**
 * 卡片动作闭环（客户端这一半，见 specs/messaging-and-channels.md §12.18）。
 *
 * 真机事故：卡片上的「已阅 / 退回」是**死的**——`ImMessageRow` 只把动作接到"查看详情"，
 * `server` 动作没有执行者，点下去毫无反应（只留一个降了透明度的按钮）。
 * 这里把三件事钉住：分派规则、执行中的等待与失败原文、退回必填意见。
 */

const onOpenItemMock = vi.fn();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  onOpenItemMock.mockReset();
});

const wrap = (node: Parameters<typeof render>[0]) =>
  render(createElement(ZCodeIntlProvider, null, node));

/** 带收件人的待审卡（新卡片）：`to` = 审核人，`_authorId` = 发起人。 */
const cardWithAudience = (over: { to?: string; from?: string; actions?: unknown[] } = {}) =>
  JSON.stringify({
    card: { version: 1, type: "platform.work-item/qa-report" },
    fallback: "[qa-report] 2026-10 第 43 周实验记录",
    title: "第 43 周实验记录",
    subtitle: "2026-10",
    ...(over.from ? { _authorId: over.from } : {}),
    ...(over.to ? { to: over.to } : {}),
    actions: over.actions ?? [
      { id: "open", label: "查看详情", kind: "client", target: "work-items.item:item-1" },
      {
        id: "review",
        label: "已阅",
        kind: "server",
        style: "primary",
        target: "work-items.item:item-1",
      },
      {
        id: "return",
        label: "退回",
        kind: "server",
        style: "danger",
        target: "work-items.item:item-1",
      },
    ],
  });

const workItemCard = JSON.stringify({
  card: { version: 1, type: "platform.work-item/qa-report" },
  fallback: "[qa-report] 2026-10 第 43 周实验记录",
  title: "第 43 周实验记录",
  subtitle: "2026-10",
  actions: [
    { id: "open", label: "查看详情", kind: "client", target: "work-items.item:item-1" },
    {
      id: "review",
      label: "已阅",
      kind: "server",
      style: "primary",
      target: "work-items.item:item-1",
    },
    {
      id: "return",
      label: "退回",
      kind: "server",
      style: "danger",
      target: "work-items.item:item-1",
    },
  ],
});

const service = (over: Partial<IImService> = {}): IImService =>
  ({
    reviewWorkItem: vi.fn().mockResolvedValue({ itemId: "item-1", status: "reviewed" }),
    ...over,
  }) as unknown as IImService;

describe("resolveImCardAction（分派规则，纯函数）", () => {
  it("工作项卡片的三个动作各就各位", () => {
    expect(
      resolveImCardAction({ id: "open", kind: "client", target: "work-items.item:a1" }),
    ).toEqual({ kind: "work-item", itemId: "a1", action: "open" });
    expect(
      resolveImCardAction({ id: "review", kind: "server", target: "work-items.item:a1" }),
    ).toEqual({ kind: "work-item", itemId: "a1", action: "review" });
    expect(
      resolveImCardAction({ id: "return", kind: "server", target: "work-items.item:a1" }),
    ).toEqual({ kind: "work-item", itemId: "a1", action: "return" });
  });

  it("存量卡片（动作自身没带 target）也能分派：靠同卡片其它动作的 target 兜底", () => {
    // 真机踩到：`server` 动作带 target 是后加的，之前投出的卡片 review/return 没有 target，
    // 用户手点直接报"这个动作暂不支持"。卡片描述的就是同一条记录，靠 open 的 target 就能认出对象。
    const legacy = {
      actions: [
        { id: "open", target: "work-items.item:legacy-1" },
        { id: "review" },
        { id: "return" },
      ],
    };
    expect(resolveImCardAction({ id: "review", kind: "server" }, legacy)).toEqual({
      kind: "work-item",
      itemId: "legacy-1",
      action: "review",
    });
    expect(resolveImCardAction({ id: "return", kind: "server" }, legacy)).toEqual({
      kind: "work-item",
      itemId: "legacy-1",
      action: "return",
    });
    // 动作自己的 target 优先于兜底
    expect(
      resolveImCardAction({ id: "review", kind: "server", target: "work-items.item:own" }, legacy),
    ).toEqual({ kind: "work-item", itemId: "own", action: "review" });
  });

  it("不认识的组合一律 unsupported（宁可置灰，也不静默失败）", () => {
    for (const action of [
      { id: "open", kind: "server" as const, target: "work-items.item:a1" }, // 打开是界面动作，不认识服务端版
      { id: "review", kind: "client" as const, target: "work-items.item:a1" },
      { id: "delete", kind: "server" as const, target: "work-items.item:a1" },
      { id: "review", kind: "server" as const }, // 自身缺 target，且卡片里也没有可兜底的（见下一条用例）
      { id: "review", kind: "server" as const, target: "unknown.kind:a1" },
      { id: "review", kind: "server" as const, target: "work-items.item:" }, // 空 id
    ]) {
      expect(resolveImCardAction(action)).toEqual({ kind: "unsupported" });
    }
  });
});

describe("ImCardRenderer 的动作按钮", () => {
  it("没有执行者时按钮禁用（而不是看着能点却什么都不发生）", () => {
    const { getByTestId, getAllByTestId } = wrap(
      createElement(ImCardRenderer, { body: workItemCard, authorLabel: "辛晓华" }),
    );
    expect(getByTestId("im-card")).toBeTruthy();
    for (const button of getAllByTestId("im-card-action")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("执行中显示等待文案，成功后不再显示错误", async () => {
    let release: () => void = () => {};
    const onAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { container, queryByTestId } = wrap(
      createElement(ImCardRenderer, { body: workItemCard, authorLabel: "辛晓华", onAction }),
    );
    const review = container.querySelector<HTMLButtonElement>('[data-card-action="review"]')!;
    fireEvent.click(review);
    // 文案随语言变，断言"离开原标题 + 禁用"这两件与语言无关的事
    await waitFor(() => expect(review.textContent).not.toBe("已阅"));
    expect(review.disabled).toBe(true);
    release();
    await waitFor(() => expect(review.textContent).toBe("已阅"));
    expect(queryByTestId("im-card-action-error")).toBeNull();
  });

  it("失败把服务端原文显示在卡片上（403 不是「点不动」，而是看得见的理由）", async () => {
    const onAction = vi.fn().mockRejectedValue(new Error("only recipients can review"));
    const { container, getByTestId } = wrap(
      createElement(ImCardRenderer, { body: workItemCard, authorLabel: "辛晓华", onAction }),
    );
    const review = container.querySelector<HTMLButtonElement>('[data-card-action="review"]')!;
    fireEvent.click(review);
    const alert = await waitFor(() => getByTestId("im-card-action-error"));
    expect(alert.textContent).toContain("only recipients can review");
    // 失败后按钮恢复可点（用户可以重试）
    await waitFor(() => expect(review.disabled).toBe(false));
  });

  it("执行时把 kind 与 target 一起交给外层（分派靠它们，不靠猜）", async () => {
    const onAction = vi.fn();
    const { getAllByTestId } = wrap(
      createElement(ImCardRenderer, { body: workItemCard, authorLabel: "辛晓华", onAction }),
    );
    const buttons = getAllByTestId("im-card-action");
    fireEvent.click(buttons[2]!); // 退回
    expect(onAction).toHaveBeenCalledWith(
      { id: "return", kind: "server", target: "work-items.item:item-1" },
      expect.objectContaining({ title: "第 43 周实验记录" }),
    );
  });
});

describe("ImCardReturnDialog（退回必填意见）", () => {
  it("空意见不提交，并就地提示", async () => {
    const reviewWorkItem = vi.fn();
    const onClose = vi.fn();
    const { getByTestId, getByRole } = wrap(
      createElement(ImCardReturnDialog, {
        service: service({ reviewWorkItem }),
        itemId: "item-1",
        title: "第 43 周实验记录",
        onClose,
      }),
    );
    fireEvent.click(getByTestId("im-card-return-submit"));
    expect(reviewWorkItem).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // 提示文案随语言变，断言"有可读的报错"这件事（说清楚为什么不让提交）
    expect((getByRole("alert").textContent ?? "").length).toBeGreaterThan(0);
  });

  it("填了意见就退回：调服务端、带 comment、成功后关闭", async () => {
    const reviewWorkItem = vi.fn().mockResolvedValue({ itemId: "item-1", status: "returned" });
    const onClose = vi.fn();
    const { getByTestId } = wrap(
      createElement(ImCardReturnDialog, {
        service: service({ reviewWorkItem }),
        itemId: "item-1",
        title: "第 43 周实验记录",
        onClose,
      }),
    );
    fireEvent.change(getByTestId("im-card-return-comment"), {
      target: { value: "测试数量与结论对不上" },
    });
    fireEvent.click(getByTestId("im-card-return-submit"));
    await waitFor(() =>
      expect(reviewWorkItem).toHaveBeenCalledWith({
        itemId: "item-1",
        status: "returned",
        comment: "测试数量与结论对不上",
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("服务端拒绝时显示原文且不关弹窗（用户能改完再试）", async () => {
    const reviewWorkItem = vi.fn().mockRejectedValue(new Error("not a reviewer"));
    const onClose = vi.fn();
    const { getByTestId, getByRole } = wrap(
      createElement(ImCardReturnDialog, {
        service: service({ reviewWorkItem }),
        itemId: "item-1",
        title: "第 43 周实验记录",
        onClose,
      }),
    );
    fireEvent.change(getByTestId("im-card-return-comment"), { target: { value: "x" } });
    fireEvent.click(getByTestId("im-card-return-submit"));
    const alert = await waitFor(() => getByRole("alert"));
    expect(alert.textContent).toContain("not a reviewer");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("useImCardActionDispatch（面板级分派）", () => {
  const document = JSON.parse(workItemCard) as Parameters<
    ReturnType<typeof useImCardActionDispatch>["dispatch"]
  >[1];

  const setup = (
    reviewWorkItem = vi.fn().mockResolvedValue({ itemId: "item-1", status: "reviewed" }),
  ) =>
    renderHook(
      (props: { service: IImService | null }) =>
        useImCardActionDispatch({
          service: props.service,
          onOpenItem: onOpenItemMock,
        }),
      {
        initialProps: { service: service({ reviewWorkItem }) as IImService | null },
        wrapper: ({ children }) => createElement(ZCodeIntlProvider, null, children),
      },
    );

  it("「已阅」直接调服务端（最短动作，不多一次确认）", async () => {
    const reviewWorkItem = vi.fn().mockResolvedValue({ itemId: "item-1", status: "reviewed" });
    const { result } = setup(reviewWorkItem);
    await act(() =>
      result.current.dispatch(
        { id: "review", kind: "server", target: "work-items.item:item-1" },
        document,
      ),
    );
    expect(reviewWorkItem).toHaveBeenCalledWith({ itemId: "item-1", status: "reviewed" });
    expect(onOpenItemMock).not.toHaveBeenCalled();
    // 已阅不需要意见，所以不开弹窗
    expect(result.current.returningReview).toBeNull();
  });

  it("「退回」不直接提交，先开弹窗收集意见", async () => {
    const reviewWorkItem = vi.fn();
    const { result } = setup(reviewWorkItem);
    await act(() =>
      result.current.dispatch(
        { id: "return", kind: "server", target: "work-items.item:item-1" },
        document,
      ),
    );
    expect(reviewWorkItem).not.toHaveBeenCalled();
    expect(result.current.returningReview).toEqual({
      itemId: "item-1",
      title: "第 43 周实验记录",
    });
    act(() => result.current.closeReturn());
    expect(result.current.returningReview).toBeNull();
  });

  it("「查看详情」走界面动作，不打服务端", async () => {
    const reviewWorkItem = vi.fn();
    const { result } = setup(reviewWorkItem);
    await act(() =>
      result.current.dispatch(
        { id: "open", kind: "client", target: "work-items.item:item-1" },
        document,
      ),
    );
    expect(onOpenItemMock).toHaveBeenCalledWith("item-1");
    expect(reviewWorkItem).not.toHaveBeenCalled();
  });

  it("作者点自己那张卡 → 服务端的英文短句翻成人话（真机只显示 400 的那个坑）", async () => {
    const reviewWorkItem = vi
      .fn()
      .mockRejectedValue(new ImHttpError(400, "invalid", "author cannot review own item"));
    const { result } = setup(reviewWorkItem);
    await expect(
      result.current.dispatch(
        { id: "review", kind: "server", target: "work-items.item:item-1" },
        document,
      ),
    ).rejects.toThrow(/submitted this record|自己提交的/i);
  });

  it("没见过的失败原因原样透出（不吞成状态码——这是修过的那个 bug）", async () => {
    const reviewWorkItem = vi
      .fn()
      .mockRejectedValue(new ImHttpError(400, "invalid", "record frozen by retention policy"));
    const { result } = setup(reviewWorkItem);
    await expect(
      result.current.dispatch(
        { id: "review", kind: "server", target: "work-items.item:item-1" },
        document,
      ),
    ).rejects.toThrow("record frozen by retention policy");
  });

  it("IM 未就绪 / 动作不认识 → 抛人话错误（渲染器会显示在卡片上）", async () => {
    const { result } = setup();
    await expect(
      result.current.dispatch(
        { id: "archive", kind: "server", target: "work-items.item:item-1" },
        document,
      ),
    ).rejects.toThrow();

    const offline = renderHook(
      () => useImCardActionDispatch({ service: null, onOpenItem: onOpenItemMock }),
      { wrapper: ({ children }) => createElement(ZCodeIntlProvider, null, children) },
    );
    await expect(
      offline.result.current.dispatch(
        { id: "review", kind: "server", target: "work-items.item:item-1" },
        document,
      ),
    ).rejects.toThrow();
  });
});

describe("按视角渲染（收件人 / 发起人 / 其他人）", () => {
  // 走真实链路：先 parseImCard（它把 `to`/`_authorId` 归一成 `audience`），再判视角
  const role = (body: string, self: string | null) => imCardViewerRole(parseImCard(body)!, self);

  it("视角判定只看卡片自己声明的 audience（不推理角色）", () => {
    const body = cardWithAudience({ from: "author-1", to: "reviewer-1" });
    expect(role(body, "reviewer-1")).toBe("addressee");
    expect(role(body, "author-1")).toBe("author");
    expect(role(body, "bystander")).toBe("observer");
    expect(role(body, null)).toBe("observer");
    // 老卡片没有 audience → unknown：界面保持原样，由服务端拒（不能因为缺字段就改变呈现）
    expect(role(workItemCard, "anyone")).toBe("unknown");
  });

  it("收件人：审核按钮可点（今天的行为）", () => {
    const { container } = wrap(
      createElement(ImCardRenderer, {
        body: cardWithAudience({ from: "author-1", to: "me" }),
        authorLabel: "IM 测试账号",
        selfUserId: "me",
      }),
    );
    const ids = [...container.querySelectorAll("[data-card-action]")].map((b) =>
      b.getAttribute("data-card-action"),
    );
    expect(ids).toEqual(["open", "review", "return"]);
    expect(container.querySelector('[data-testid="im-card-author-note"]')).toBeNull();
  });

  it("发起人：不再摆点不动的审核按钮，换成一行「你提交的 · 等审核人处理」", () => {
    const { container } = wrap(
      createElement(ImCardRenderer, {
        body: cardWithAudience({ from: "me", to: "reviewer-1" }),
        authorLabel: "辛晓华",
        selfUserId: "me",
      }),
    );
    const ids = [...container.querySelectorAll("[data-card-action]")].map((b) =>
      b.getAttribute("data-card-action"),
    );
    // 「查看详情」仍在（那是界面动作，作者也要能看），审核动作消失
    expect(ids).toEqual(["open"]);
    expect(container.querySelector('[data-testid="im-card-author-note"]')).not.toBeNull();
  });

  it("发起人看**已处理**的卡片：动作已被服务端摘掉，就不再提示「等审核人处理」", () => {
    const decided = cardWithAudience({
      from: "me",
      to: "reviewer-1",
      actions: [
        { id: "open", label: "查看详情", kind: "client", target: "work-items.item:item-1" },
      ],
    });
    const { container } = wrap(
      createElement(ImCardRenderer, { body: decided, authorLabel: "辛晓华", selfUserId: "me" }),
    );
    expect(container.querySelector('[data-testid="im-card-author-note"]')).toBeNull();
  });

  it("其他人：只读（隐藏 server 动作），不做任何提示", () => {
    const { container } = wrap(
      createElement(ImCardRenderer, {
        body: cardWithAudience({ from: "author-1", to: "reviewer-1" }),
        authorLabel: "IM 测试账号",
        selfUserId: "bystander",
      }),
    );
    expect(
      [...container.querySelectorAll("[data-card-action]")].map((b) =>
        b.getAttribute("data-card-action"),
      ),
    ).toEqual(["open"]);
  });

  it("老卡片（没有 audience）保持原样：按钮照常显示，由服务端拒", () => {
    const { container } = wrap(
      createElement(ImCardRenderer, {
        body: workItemCard,
        authorLabel: "辛晓华",
        selfUserId: "me",
      }),
    );
    expect(
      [...container.querySelectorAll("[data-card-action]")].map((b) =>
        b.getAttribute("data-card-action"),
      ),
    ).toEqual(["open", "review", "return"]);
  });
});
