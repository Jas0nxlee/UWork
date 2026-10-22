// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewPaneModelContent } from "@/previewPaneModelContent.js";
import type { ModelPreviewViewerLabels } from "@/modelPreview/ModelPreviewViewer.js";

const labels: ModelPreviewViewerLabels = {
  loading: "正在加载 3D 模型...",
  resetView: "重置视角",
  unavailable: "暂时无法预览这个 3D 模型。",
  invalidData: "不是有效的 3D 模型",
  emptyModel: "没有可渲染的几何数据",
  unsupportedExtension: (extensions) => `不支持压缩扩展 ${extensions}`,
  missingResource: (uri) => `外部数据文件读不到 ${uri}`,
  webglUnavailable: "当前环境无法创建 3D 渲染上下文",
  summary: ({ triangles, size }) => `${triangles} 三角面 · ${size}`,
};

// 这个 vitest 工程没有开 globals，Testing Library 的自动 cleanup 不会生效；
// 不手动清理的话上一条用例的 DOM 会留在文档里，getByRole 会撞见多个 alert。
afterEach(() => cleanup());

function renderContent(overrides: Partial<Parameters<typeof PreviewPaneModelContent>[0]> = {}) {
  return render(
    createElement(PreviewPaneModelContent, {
      data: null,
      error: null,
      format: "gltf" as const,
      labels,
      loading: false,
      modelPath: "/workspace/scene.glb",
      readBytes: async () => new Uint8Array(0),
      resolvedTheme: "light" as const,
      ...overrides,
    }),
  );
}

describe("PreviewPaneModelContent", () => {
  it("字节还没读到时显示加载文案", () => {
    renderContent({ loading: true });
    expect(screen.getByText(labels.loading)).toBeTruthy();
  });

  it("读取失败时显示错误文案（而不是空白）", () => {
    renderContent({ error: "文件超过 25 MB" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("文件超过 25 MB");
  });

  it("jsdom 里没有 WebGL：挂载 viewer 后给出可读错误态而不是崩溃", async () => {
    renderContent({ data: new Uint8Array([1, 2, 3, 4]) });
    // viewer 是懒加载的（three 单独分包），要等动态 import 落地。
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(labels.webglUnavailable);
    });
  });
});
