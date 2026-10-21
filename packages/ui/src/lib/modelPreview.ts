/**
 * 3D 模型预览的格式表。
 *
 * 与 Office 预览分开：Office 走 `readBinaryPreview` 的 25 MB base64 通道，模型也复用同一条
 * （对 .glb/.stl 这类几十兆的资产够用），因此这里不需要额外的大小边界，只负责"哪些扩展名
 * 算 3D 模型"以及它对应哪个解析器。
 */
export type ModelPreviewFormat = "gltf" | "obj" | "stl" | "ply" | "3mf";

const MODEL_PREVIEW_EXTENSIONS: Record<string, ModelPreviewFormat> = {
  "3mf": "3mf",
  glb: "gltf",
  gltf: "gltf",
  obj: "obj",
  ply: "ply",
  stl: "stl",
};

export function getModelPreviewFormat(path?: string): ModelPreviewFormat | null {
  if (!path) {
    return null;
  }

  const leaf = path.trim().replace(/\\/g, "/").split("/").pop();
  if (!leaf) {
    return null;
  }

  const dotIndex = leaf.lastIndexOf(".");
  // `.glb.txt` / `.obj.bak` 这类伪装扩展名必须落到普通文件预览，不能按"包含即命中"识别。
  if (dotIndex <= 0 || dotIndex === leaf.length - 1) {
    return null;
  }

  return MODEL_PREVIEW_EXTENSIONS[leaf.slice(dotIndex + 1).toLowerCase()] ?? null;
}

export function isModelPreviewPath(path?: string): boolean {
  return getModelPreviewFormat(path) !== null;
}
