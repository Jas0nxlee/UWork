/** 只读格式、文案和宿主文件端口；不引入 three 或 React 运行时。 */
export type ModelPreviewFormat = "gltf" | "obj" | "stl" | "ply" | "3mf";

export interface ModelPreviewViewerLabels {
  loading: string;
  resetView: string;
  unavailable: string;
  invalidData: string;
  emptyModel: string;
  unsupportedExtension: (extensions: string) => string;
  missingResource: (uri: string) => string;
  webglUnavailable: string;
  /** 一行模型信息：三角面数与包围盒尺寸。 */
  summary: (values: { triangles: string; size: string }) => string;
}

export interface ModelPreviewViewerProps {
  data: Uint8Array;
  format: ModelPreviewFormat;
  labels: ModelPreviewViewerLabels;
  modelPath: string;
  readBytes: (path: string) => Promise<Uint8Array>;
  resolvedTheme: "light" | "dark";
}
