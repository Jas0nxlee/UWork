// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImComposer } from "@/im/ImComposer.js";

/**
 * IM 输入框的拖入。
 *
 * 会话侧（agent 对话）早就有拖入了（`v4/ConversationComposer` 的 handleConversationDrop，OS 文件走上传、
 * 文件树 payload 走 mention）；IM 侧原来只有"附件按钮"，两边不一致。这里补齐：**拖到输入框 = 直接发送文件**，
 * 复用同一条上传/发送路径（`onFiles`）。
 *
 * 注意 JSON 化的 `dataTransfer`：jsdom 里造不出真的 DataTransfer，只能把 files/types 直接塞进事件对象。
 * 真实 OS 拖拽走的是同一个 drop 事件与同一份 `dataTransfer.files`，所以这里验的是"收到文件后做什么"。
 */
const file = (name: string, bytes = "hello") => new File([bytes], name, { type: "text/plain" });

const renderComposer = (overrides: Partial<Parameters<typeof ImComposer>[0]> = {}) => {
  const onFiles = vi.fn();
  const fileInputRef = { current: null } as React.RefObject<HTMLInputElement | null>;
  const view = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ImComposer, {
        editing: null,
        onEditSave: () => undefined,
        onEditCancel: () => undefined,
        mentionCandidates: [],
        replyTo: null,
        selfUserId: "u-me",
        selfName: "辛晓华",
        nameOf: () => undefined,
        draft: "",
        onDraftChange: () => undefined,
        sending: false,
        uploading: false,
        typingLabel: null,
        actionError: null,
        onCancelReply: () => undefined,
        onSubmit: () => undefined,
        onFiles,
        fileInputRef,
        onTyping: () => undefined,
        mentions: [],
        onMentionsChange: () => undefined,
        ...overrides,
      }),
    ),
  );
  return { ...view, onFiles };
};

afterEach(cleanup);

describe("IM 输入框拖入文件", () => {
  it("拖入文件会走发送路径，并把文件名交给 onFiles", () => {
    const { container, onFiles } = renderComposer();
    const target = container.firstElementChild as HTMLElement;
    const dropped = file("实验记录-2026W42.xlsx");

    const notCancelled = fireEvent.drop(target, {
      dataTransfer: { files: [dropped], types: ["Files"] },
    });

    expect(onFiles).toHaveBeenCalledTimes(1);
    const passed = onFiles.mock.calls[0]?.[0] as unknown as File[];
    expect(passed).toHaveLength(1);
    expect(passed[0]?.name).toBe("实验记录-2026W42.xlsx");
    // 不 preventDefault 的话，Chromium 会用这个文件替换掉整个页面
    expect(notCancelled).toBe(false);
  });

  it("拖入时给提示、松手后收起（否则用户会以为拖进来没反应）", () => {
    const { container } = renderComposer();
    const target = container.firstElementChild as HTMLElement;

    expect(screen.queryByTestId("im-drop-hint")).toBeNull();
    fireEvent.dragOver(target, { dataTransfer: { files: [], types: ["Files"] } });
    expect(screen.getByTestId("im-drop-hint").textContent).toBe("松开即发送文件");

    fireEvent.drop(target, { dataTransfer: { files: [file("a.txt")], types: ["Files"] } });
    expect(screen.queryByTestId("im-drop-hint")).toBeNull();
  });

  it("拖文本进来不点亮提示，也不当文件发出去", () => {
    const { container, onFiles } = renderComposer();
    const target = container.firstElementChild as HTMLElement;

    fireEvent.dragOver(target, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(screen.queryByTestId("im-drop-hint")).toBeNull();

    fireEvent.drop(target, { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("从文件树拖入（只有路径、没有 File）不假装成功", () => {
    const { container, onFiles } = renderComposer();
    const target = container.firstElementChild as HTMLElement;

    fireEvent.drop(target, {
      dataTransfer: { files: [], types: ["application/x-uwork-workspace-file"] },
    });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
