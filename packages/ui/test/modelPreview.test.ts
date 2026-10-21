// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { getModelPreviewFormat, isModelPreviewPath } from "@/lib/modelPreview.js";
import { ModelLoadError, preparePreviewMaterials } from "@/modelPreview/modelPreviewLoaders.js";
import { resolveSiblingResourcePath } from "@/modelPreview/modelPreviewResources.js";
import {
  resolveLoadErrorText,
  type ModelPreviewViewerLabels,
} from "@/modelPreview/ModelPreviewViewer.js";

const labels: ModelPreviewViewerLabels = {
  loading: "loading",
  resetView: "reset",
  unavailable: "unavailable",
  invalidData: "invalid",
  emptyModel: "empty",
  unsupportedExtension: (extensions) => `unsupported:${extensions}`,
  missingResource: (uri) => `missing:${uri}`,
  webglUnavailable: "webgl",
  summary: ({ triangles, size }) => `${triangles} tris ${size}`,
};

describe("3D 模型格式识别", () => {
  it.each([
    ["model.glb", "gltf"],
    ["MODEL.GLB", "gltf"],
    ["scene.gltf", "gltf"],
    ["part.obj", "obj"],
    ["part.PLY", "ply"],
    ["chip.stl", "stl"],
    ["print.3mf", "3mf"],
    ["C:\\models\\scene.glb", "gltf"],
  ])("识别 %s 为 %s", (path, expected) => {
    expect(getModelPreviewFormat(path)).toBe(expected);
    expect(isModelPreviewPath(path)).toBe(true);
  });

  it.each([
    ["model.glb.txt", "伪装后缀"],
    ["model.obj.bak", "备份文件"],
    ["report.docx", "Office"],
    ["slides.pptx", "演示文稿"],
    ["paper.pdf", "PDF"],
    ["README", "没有扩展名"],
    [undefined, "空路径"],
  ])("不把 %s 当成 3D 模型（%s）", (path) => {
    expect(getModelPreviewFormat(path)).toBeNull();
    expect(isModelPreviewPath(path)).toBe(false);
  });
});

describe("同目录外部资源路径", () => {
  it.each([
    ["scene.bin", "/models/scene.bin"],
    ["textures/albedo.png", "/models/textures/albedo.png"],
    ["./textures/albedo.png", "/models/textures/albedo.png"],
    ["textures/../scene.bin", "/models/scene.bin"],
    ["my%20texture.png", "/models/my texture.png"],
    ["scene.bin?cache=1", "/models/scene.bin"],
  ])("把 %s 解析到 %s", (uri, expected) => {
    expect(resolveSiblingResourcePath("/models/model.gltf", uri)).toBe(expected);
  });

  it.each([
    ["../outside.bin", "上跳逃出模型目录"],
    ["textures/../../outside.bin", "多级上跳"],
    ["/etc/passwd", "绝对路径"],
    ["C:\\Windows\\system.ini", "Windows 绝对路径"],
    ["https://example.com/tex.png", "http 外链（绝不抓取）"],
    ["blob:https://example.com/uuid", "blob 协议"],
    ["file:///etc/passwd", "file 协议"],
    ["data:image/png;base64,AAAA", "内联数据由渲染器处理"],
    ["", "空引用"],
  ])("拒绝 %s（%s）", (uri) => {
    expect(resolveSiblingResourcePath("/models/model.gltf", uri)).toBeNull();
  });
});

describe("预览宽容化（缺法线 / 单面剔除）", () => {
  it("补齐缺失的法线并把材质改成双面", async () => {
    const { BufferGeometry, DoubleSide, FrontSide, Mesh, MeshStandardMaterial } =
      await import("three");
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new (await import("three")).Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    const material = new MeshStandardMaterial();
    material.side = FrontSide;
    const mesh = new Mesh(geometry, material);

    preparePreviewMaterials(mesh);

    expect(geometry.attributes.normal).toBeDefined();
    expect(material.side).toBe(DoubleSide);
  });

  it("已经有法线的几何不被改写", async () => {
    const { BufferGeometry, Float32BufferAttribute, Mesh, MeshStandardMaterial } =
      await import("three");
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setAttribute("normal", new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    const before = geometry.attributes.normal;
    preparePreviewMaterials(new Mesh(geometry, new MeshStandardMaterial()));
    expect(geometry.attributes.normal).toBe(before);
  });
});

describe("失败文案归类", () => {
  it("按 failure 走对应文案", () => {
    expect(
      resolveLoadErrorText(
        new ModelLoadError(
          { kind: "unsupported-extension", extensions: ["KHR_draco_mesh_compression"] },
          "draco",
        ),
        labels,
      ),
    ).toBe("unsupported:KHR_draco_mesh_compression");
    expect(
      resolveLoadErrorText(
        new ModelLoadError({ kind: "missing-resource", uri: "scene.bin" }, "missing"),
        labels,
      ),
    ).toBe("missing:scene.bin");
    expect(resolveLoadErrorText(new ModelLoadError({ kind: "invalid-data" }, "bad"), labels)).toBe(
      "invalid",
    );
    expect(resolveLoadErrorText(new ModelLoadError({ kind: "empty-model" }, "empty"), labels)).toBe(
      "empty",
    );
    expect(resolveLoadErrorText(new Error("loader exploded"), labels)).toBe("unavailable");
  });
});
