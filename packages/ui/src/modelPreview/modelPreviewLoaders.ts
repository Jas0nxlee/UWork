/**
 * 3D 模型的解析层：把字节变成 three 的 `Object3D`，并顺带管住两件必须做对的事。
 *
 * ① **按格式懒加载**：每个格式的 loader 都走 `import()`，打开一个 STL 不会下载别的解析器。
 * ② **外部资源只走工作区读取**：glTF 的 `.bin`/贴图、OBJ 的 `.mtl` 按模型同级目录解析，
 *    读不到就降级（贴图用透明占位）；`http(s)://` 一律不抓，`..` 上跳一律拒绝——
 *    打开一个本地模型不该变成出网通道或跨目录读取的放大器。
 */
import {
  BufferGeometry,
  DoubleSide,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  type Object3D,
  type Texture,
} from "three";
import { logger } from "@/logger.js";
import type { ModelPreviewFormat } from "@/lib/modelPreview.js";
import {
  collectUris,
  readMtlTextureToken,
  readResourceUrls,
  rewriteGltfResources,
  resolveSiblingResourcePath,
  TRANSPARENT_PNG,
} from "@/modelPreview/modelPreviewResources.js";

/** 无材质信息时的默认颜色（STL / 无 MTL 的 OBJ / 无顶点色的 PLY）。 */
const DEFAULT_MODEL_COLOR = 0xa8b1bd;
const GLB_MAGIC = 0x46546c67;
const UNSUPPORTED_EXTENSIONS = [
  "KHR_draco_mesh_compression",
  "KHR_texture_basisu",
  "EXT_meshopt_compression",
];
export type ModelLoadFailure =
  | { kind: "unsupported-extension"; extensions: string[] }
  | { kind: "missing-resource"; uri: string }
  | { kind: "invalid-data" }
  | { kind: "empty-model" };

export class ModelLoadError extends Error {
  readonly failure: ModelLoadFailure;

  constructor(failure: ModelLoadFailure, message: string) {
    super(message);
    this.name = "ModelLoadError";
    this.failure = failure;
  }
}

/** 释放一棵场景树的 GPU 资源（几何 + 材质 + 材质上的贴图）。 */
export function disposeObject3D(root: Object3D): void {
  root.traverse((child) => {
    const node = child as { geometry?: BufferGeometry; material?: unknown };
    node.geometry?.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!material) {
        continue;
      }
      for (const value of Object.values(material as Record<string, unknown>)) {
        if (value && typeof value === "object" && (value as Texture).isTexture) {
          (value as Texture).dispose();
        }
      }
      (material as { dispose?: () => void }).dispose?.();
    }
  });
}

function decodeText(data: ArrayBuffer | Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

function createDefaultMaterial(vertexColors = false): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: vertexColors ? 0xffffff : DEFAULT_MODEL_COLOR,
    metalness: 0.05,
    roughness: 0.55,
    // 3D 打印与扫描模型常有翻转法线／非流形面，双面渲染让"看得见东西"优先于背面阴影精度。
    side: DoubleSide,
    vertexColors,
  });
}

/**
 * 预览要"看得见东西"优先：模型来自 agent / 扫描仪 / 3D 打印导出，绕序与法线方向经常不自洽，
 * 单面剔除会让面片凭空消失（真机反馈："金字塔只有一两个面能看到，转一下就没了"）；
 * 缺 `vn` 的 OBJ 更是连光照都算不出来。所以统一补法线 + 强制双面。
 */
export function preparePreviewMaterials(root: Object3D): void {
  root.traverse((child) => {
    const node = child as { geometry?: BufferGeometry; material?: unknown };
    if (node.geometry?.attributes?.position && !node.geometry.attributes.normal) {
      node.geometry.computeVertexNormals();
    }
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material && "side" in material) {
        (material as { side: number }).side = DoubleSide;
      }
    }
  });
}

function wrapMesh(geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  if (!geometry.attributes.normal) {
    geometry.computeVertexNormals();
  }
  return new Mesh(geometry, material);
}

function assertSupportedExtensions(gltfJson: unknown): void {
  const required =
    typeof gltfJson === "object" && gltfJson !== null
      ? (gltfJson as { extensionsRequired?: unknown }).extensionsRequired
      : null;
  if (!Array.isArray(required)) {
    return;
  }
  const unsupported = required.filter(
    (extension) => typeof extension === "string" && UNSUPPORTED_EXTENSIONS.includes(extension),
  );
  if (unsupported.length > 0) {
    // 静默失败会变成"模型一片空白"这种最难排查的形态，这里直接给出可读原因。
    throw new ModelLoadError(
      { kind: "unsupported-extension", extensions: unsupported },
      `Model requires unsupported glTF extensions: ${unsupported.join(", ")}`,
    );
  }
}

/** GLB 是自包含容器：12 字节头 + 分块，第一块固定是 JSON；按**内容**判断，不认扩展名。 */
function readGlbJsonChunk(data: ArrayBuffer): unknown | null {
  if (data.byteLength < 20 || new DataView(data).getUint32(0, true) !== GLB_MAGIC) {
    return null;
  }
  const view = new DataView(data);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > data.byteLength) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, jsonLength)));
  } catch {
    return null;
  }
}

export interface LoadModelOptions {
  data: Uint8Array;
  format: ModelPreviewFormat;
  modelPath: string;
  /** 异步贴图加载完成时回调，用于补一帧。 */
  onResourceSettled?: () => void;
  readBytes: (path: string) => Promise<Uint8Array>;
}

/**
 * 所有格式的统一出口：补法线 + 强制双面。
 * 分开一层是因为"宽容化"是**预览口径**，与各格式怎么解析无关，放在出口处只写一遍。
 */
export async function loadModelObject(options: LoadModelOptions): Promise<Object3D> {
  const object = await loadRawModelObject(options);
  preparePreviewMaterials(object);
  return object;
}

async function loadRawModelObject({
  data,
  format,
  modelPath,
  onResourceSettled,
  readBytes,
}: LoadModelOptions): Promise<Object3D> {
  const buffer =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? (data.buffer as ArrayBuffer)
      : (data.slice().buffer as ArrayBuffer);

  if (format === "gltf") {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const glbJson = readGlbJsonChunk(buffer);
    if (glbJson) {
      assertSupportedExtensions(glbJson);
      return (await loader.parseAsync(buffer, "")).scene;
    }

    let json: unknown;
    try {
      json = JSON.parse(decodeText(buffer));
    } catch {
      throw new ModelLoadError({ kind: "invalid-data" }, "glTF JSON could not be parsed");
    }
    assertSupportedExtensions(json);
    const resources = await readResourceUrls({
      modelPath,
      readBytes,
      uris: [...collectUris(json, "buffers"), ...collectUris(json, "images")],
    });
    const { json: rewritten, missingBufferUri } = rewriteGltfResources(json, resources.urls);
    if (missingBufferUri) {
      resources.release();
      // 几何就在 buffer 里，换成占位符等于假装能渲染；如实报错。
      throw new ModelLoadError(
        { kind: "missing-resource", uri: missingBufferUri },
        `glTF buffer could not be read: ${missingBufferUri}`,
      );
    }
    try {
      return (await loader.parseAsync(JSON.stringify(rewritten), "")).scene;
    } finally {
      resources.release();
    }
  }

  if (format === "obj") {
    const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
      import("three/examples/jsm/loaders/OBJLoader.js"),
      import("three/examples/jsm/loaders/MTLLoader.js"),
    ]);
    const objText = decodeText(buffer);
    const manager = new LoadingManager();
    if (onResourceSettled) {
      manager.onLoad = onResourceSettled;
    }

    const libraryTexts: string[] = [];
    const textureUris: string[] = [];
    for (const match of objText.matchAll(/^\s*mtllib\s+(.+)$/gim)) {
      for (const name of (match[1] ?? "").trim().split(/\s+/).filter(Boolean)) {
        const path = resolveSiblingResourcePath(modelPath, name);
        if (!path) {
          continue;
        }
        try {
          const text = decodeText(await readBytes(path));
          libraryTexts.push(text);
          for (const line of text.matchAll(
            /^\s*(?:map_[a-z0-9_]+|bump|disp|decal|refl)\s+(.+)$/gim,
          )) {
            const token = readMtlTextureToken(line[1] ?? "");
            if (token && !token.toLowerCase().startsWith("data:")) {
              textureUris.push(token);
            }
          }
        } catch {
          logger.warn("[ModelPreview] MTL 读取失败", { path });
        }
      }
    }

    const resources = await readResourceUrls({
      modelPath,
      readBytes,
      uris: [...new Set(textureUris)],
    });
    const creators = libraryTexts.map((text) => {
      const rewritten = text
        .split(/\r?\n/)
        .map((line) => {
          const match = /^\s*(?:map_[a-z0-9_]+|bump|disp|decal|refl)\s+(.+)$/i.exec(line);
          const token = match?.[1] ? readMtlTextureToken(match[1]) : null;
          if (!token || token.toLowerCase().startsWith("data:")) {
            return line;
          }
          const replacement = resources.urls.get(token) ?? TRANSPARENT_PNG;
          const index = line.lastIndexOf(token);
          return index === -1 ? line : `${line.slice(0, index)}${replacement}`;
        })
        .join("\n");
      const creator = new MTLLoader(manager).parse(rewritten, "");
      creator.preload();
      return creator;
    });

    const loader = new OBJLoader(manager);
    if (creators.length > 0) {
      // OBJLoader 只调用 `materials.create(name)`：用一个 creator 承载多家材质库。
      const carrier = creators[0]!;
      for (const creator of creators.slice(1)) {
        Object.assign(carrier.materials, creator.materials);
      }
      loader.setMaterials(carrier);
    }

    const object = loader.parse(objText);
    if (creators.length === 0) {
      // 没有 MTL 时 OBJLoader 会自己造白色 Phong 材质；统一成与 STL/PLY 一致的默认材质。
      const material = createDefaultMaterial();
      object.traverse((child) => {
        if ((child as Mesh).isMesh) {
          (child as Mesh).material = material;
        }
      });
    }
    return object;
  }

  if (format === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    // STLLoader 按入参类型分流（ArrayBuffer=二进制、字符串=ASCII）。二进制 STL 的文件头也常以
    // "solid" 开头，所以用"84 + 50 × 三角面数"这个恒等式判编码。
    const view = buffer.byteLength >= 84 ? new DataView(buffer) : null;
    const isBinary = view !== null && buffer.byteLength === 84 + view.getUint32(80, true) * 50;
    return wrapMesh(
      new STLLoader().parse(isBinary ? buffer : decodeText(buffer)),
      createDefaultMaterial(),
    );
  }

  if (format === "ply") {
    const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
    // 头部（两种编码都是 ASCII）里没有 `element face` 就是纯点云。
    const header = decodeText(buffer.slice(0, Math.min(2048, buffer.byteLength)));
    const geometry = new PLYLoader().parse(buffer);
    if (!/^\s*element\s+face\b/im.test(header)) {
      const hasColors = geometry.hasAttribute("color");
      return new Points(
        geometry,
        new PointsMaterial({
          color: hasColors ? 0xffffff : DEFAULT_MODEL_COLOR,
          size: 2,
          sizeAttenuation: false,
          vertexColors: hasColors,
        }),
      );
    }
    return wrapMesh(geometry, createDefaultMaterial(geometry.hasAttribute("color")));
  }

  const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
  return new ThreeMFLoader().parse(buffer) as Object3D;
}
