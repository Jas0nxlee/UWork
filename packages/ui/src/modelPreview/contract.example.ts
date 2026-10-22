import type { ModelPreviewViewerLabels, ModelPreviewViewerProps } from "./contract.js";

/** 宿主提供字节和既有文件端口；示例不会创建第二条文件读取通道。 */
export function exampleModelPreviewProps(input: {
  data: Uint8Array;
  labels: ModelPreviewViewerLabels;
  readBytes: ModelPreviewViewerProps["readBytes"];
}): ModelPreviewViewerProps {
  return { ...input, format: "gltf", modelPath: "/workspace/model.glb", resolvedTheme: "dark" };
}
