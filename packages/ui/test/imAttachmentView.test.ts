// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { IImService } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ImAttachmentView, formatBytes } from "@/im/ImAttachmentView.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";

/** 造一个只实现 downloadAttachment 的假服务。 */
function fakeService(bytes: Uint8Array): IImService {
  return {
    downloadAttachment: vi.fn(async () => bytes),
  } as unknown as IImService;
}

const body = JSON.stringify({
  attachmentId: "a-1",
  name: "报告 v2.pdf",
  mime: "application/pdf",
  size: 3 * 1024 * 1024,
});

function renderView(options: {
  service: IImService | null;
  platform?: Record<string, unknown>;
  body?: string;
}) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform: (options.platform ?? {}) as never },
        createElement(ImAttachmentView, {
          service: options.service,
          body: options.body ?? body,
        }),
      ),
    ),
  );
}

afterEach(cleanup);

describe("附件渲染", () => {
  it("体积格式化：B / KB / MB 各一档", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("非图片给文件卡片（名字 + 体积）", () => {
    const { container } = renderView({ service: fakeService(new Uint8Array([1, 2, 3])) });
    const card = container.querySelector('[data-testid="im-attachment-file"]');
    expect(card?.textContent).toContain("报告 v2.pdf");
    expect(card?.textContent).toContain("3.0 MB");
  });

  it("桌面端点击下载走宿主落盘，并显示保存路径", async () => {
    const saveImAttachment = vi.fn(async () => ({
      path: "/tmp/uwork-im-test/报告 v2.pdf",
      name: "报告 v2.pdf",
      sizeBytes: 3,
    }));
    const { container } = renderView({
      service: fakeService(new Uint8Array([1, 2, 3])),
      platform: { saveImAttachment },
    });
    (container.querySelector('[data-testid="im-attachment-file"]') as HTMLButtonElement).click();
    await waitFor(() => expect(saveImAttachment).toHaveBeenCalledTimes(1));
    expect(saveImAttachment).toHaveBeenCalledWith({
      name: "报告 v2.pdf",
      bytes: expect.any(Uint8Array),
    });
    await waitFor(() =>
      expect(container.textContent).toContain("已保存到 /tmp/uwork-im-test/报告 v2.pdf"),
    );
  });

  it("载荷坏掉时给一句提示，而不是把 JSON 画出来", () => {
    const { container } = renderView({ service: null, body: "{not json" });
    expect(container.textContent).toContain("这条附件消息无法解析");
    expect(container.textContent).not.toContain("attachmentId");
  });

  it("图片按鉴权下载成 blob 再内联（不带令牌进 URL）", async () => {
    const service = fakeService(new Uint8Array([137, 80, 78, 71]));
    const { container } = renderView({
      service,
      body: JSON.stringify({ attachmentId: "a-2", name: "图.png", mime: "image/png", size: 4 }),
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="im-attachment-image"] img')).not.toBeNull(),
    );
    const img = container.querySelector('[data-testid="im-attachment-image"] img');
    expect(img?.getAttribute("src")?.startsWith("blob:")).toBe(true);
    expect(service.downloadAttachment as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("a-2");
  });
});
