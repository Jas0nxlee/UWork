import { describe, expect, it, vi } from "vitest";
import { getModelPreviewFormat } from "@/lib/modelPreview.js";
import { exampleModelPreviewProps } from "./contract.example.js";
import type { ModelPreviewViewerLabels } from "./contract.js";

const labels: ModelPreviewViewerLabels = {
  loading: "Loading",
  resetView: "Reset",
  unavailable: "Unavailable",
  invalidData: "Invalid",
  emptyModel: "Empty",
  webglUnavailable: "No WebGL",
  unsupportedExtension: (extensions) => extensions,
  missingResource: (uri) => uri,
  summary: ({ triangles, size }) => `${triangles}: ${size}`,
};

describe("model-preview 宿主契约", () => {
  it("识别入口接受模型格式并拒绝伪装扩展名", () => {
    expect(getModelPreviewFormat("/workspace/model.GLB")).toBe("gltf");
    expect(getModelPreviewFormat("/workspace/model.glb.txt")).toBeNull();
  });

  it("宿主示例保留原始字节与异步读取端口，装配时不读取外部资源", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const readBytes = vi.fn(async (_path: string) => bytes);
    const props = exampleModelPreviewProps({ data: bytes, labels, readBytes });
    expect(props.data).toBe(bytes);
    expect(props.readBytes).toBe(readBytes);
    expect(readBytes).not.toHaveBeenCalled();
    expect(await props.readBytes("/workspace/texture.png")).toBe(bytes);
    expect(readBytes).toHaveBeenCalledExactlyOnceWith("/workspace/texture.png");
  });
});
