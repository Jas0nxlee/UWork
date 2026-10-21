/**
 * 3D 模型的**同级外部资源**：把模型里的相对引用解析成同级路径，读成 blob URL 交给 three。
 *
 * 安全口径（模型内容不受信任）：只接受同级目录内的相对路径——`http(s)://` 一律不抓（打开本地模型
 * 不能成为出网通道），绝对路径与 `..` 上跳一律拒绝。读不到的贴图退化成透明占位；
 * 读不到的 buffer（几何就在里面）把引用回报给调用方，由它明确报错，不假装能渲染。
 */
import { logger } from "@/logger.js";

/** 贴图缺失时的 1×1 透明占位：绝不把原引用交回给 three 去请求。 */
export const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * 把模型里的相对引用解析成同级（或子目录）路径；不可解析时返回 `null`。
 * 协议引用、绝对路径与 `..` 上跳都在这里被拒绝。
 */
export function resolveSiblingResourcePath(modelPath: string, uri: string): string | null {
  const trimmed = uri.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:/.test(trimmed) ||
    trimmed.startsWith("\\\\")
  ) {
    return null;
  }

  const directory = modelPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  if (!directory) {
    return null;
  }

  const decoded = (() => {
    try {
      return decodeURI(trimmed.split(/[?#]/)[0] ?? "");
    } catch {
      return trimmed;
    }
  })();

  // 以模型所在目录为地板：`..` 只能在自己的子目录里回绕，跳出模型目录一律拒绝，
  // 否则一个手工构造的引用就能读到工作区别处的文件。
  const directorySegments = directory.split("/").filter(Boolean);
  const segments = [...directorySegments];
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length <= directorySegments.length) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${directory.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

export function collectUris(gltfJson: unknown, key: "buffers" | "images"): string[] {
  const entries =
    typeof gltfJson === "object" && gltfJson !== null
      ? (gltfJson as Record<string, unknown>)[key]
      : null;
  if (!Array.isArray(entries)) {
    return [];
  }
  const uris = entries
    .map((entry) =>
      typeof entry === "object" && entry !== null ? (entry as { uri?: unknown }).uri : undefined,
    )
    .filter(
      (uri): uri is string =>
        typeof uri === "string" && uri.trim() !== "" && !uri.toLowerCase().startsWith("data:"),
    );
  return [...new Set(uris)];
}

export async function readResourceUrls({
  modelPath,
  readBytes,
  uris,
}: {
  modelPath: string;
  readBytes: (path: string) => Promise<Uint8Array>;
  uris: readonly string[];
}): Promise<{ urls: Map<string, string>; release: () => void }> {
  const urls = new Map<string, string>();
  for (const uri of uris) {
    const path = resolveSiblingResourcePath(modelPath, uri);
    if (!path) {
      continue;
    }
    try {
      const bytes = await readBytes(path);
      urls.set(uri, URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer])));
    } catch {
      // 贴图读不到不该让整份模型打不开；buffer 读不到由调用方明确报错。
      logger.warn("[ModelPreview] 外部资源读取失败", { uri, path });
    }
  }
  return {
    urls,
    release: () => {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    },
  };
}

/**
 * 把 glTF 的 buffers/images 引用换成可用 URL。
 * 贴图缺失换成透明占位；buffer 缺失记在 `missingBufferUri` 里交回调用方（几何就在 buffer 里）。
 */
export function rewriteGltfResources(
  json: unknown,
  urls: Map<string, string>,
): { json: unknown; missingBufferUri: string | null } {
  const source = json as Record<string, unknown>;
  let missingBufferUri: string | null = null;

  const rewrite = (key: "buffers" | "images"): unknown => {
    if (!Array.isArray(source[key])) {
      return source[key];
    }
    return (source[key] as unknown[]).map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return entry;
      }
      const uri = (entry as { uri?: unknown }).uri;
      if (typeof uri !== "string" || !uri.trim() || uri.toLowerCase().startsWith("data:")) {
        return entry;
      }
      const resolved = urls.get(uri);
      if (resolved) {
        return { ...entry, uri: resolved };
      }
      if (key === "buffers") {
        missingBufferUri ??= uri;
        return entry;
      }
      return { ...entry, uri: TRANSPARENT_PNG };
    });
  };

  return {
    json: { ...source, buffers: rewrite("buffers"), images: rewrite("images") },
    missingBufferUri,
  };
}

/** MTL 里引用贴图的行（`map_Kd`、`bump`、`disp`…），取掉选项与数值参数后的那个 token。 */
export function readMtlTextureToken(argumentText: string): string | null {
  for (const token of argumentText.trim().split(/\s+/)) {
    if (
      !token ||
      token.startsWith("-") ||
      /^[-+]?\d*\.?\d+$/.test(token) ||
      /^(on|off)$/i.test(token)
    ) {
      continue;
    }
    return token;
  }
  return null;
}
