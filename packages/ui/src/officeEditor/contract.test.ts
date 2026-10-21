// @vitest-environment jsdom
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { OfficeEditorFilePort } from "./contract.js";
import { exampleOfficeEditorProps } from "./contract.example.js";
import { validateDocxCandidate } from "./docxValidate.js";
import { savePptxDocument } from "./pptSave.js";
import { validatePptxCandidate } from "./pptxValidate.js";
import { insertTextBox, readSlideShapes, setShapeTextFormat } from "./pptShapes.js";

const slideName = "ppt/slides/slide1.xml";
const slideXml =
  '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>原始正文内容</a:t></p:sld>';

async function deck(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/presentation.xml", "<presentation/>");
  zip.file(slideName, slideXml);
  zip.file("ppt/media/image.png", new Uint8Array([1, 2, 3]));
  return zip.generateAsync({ type: "arraybuffer" });
}

function filePort(): OfficeEditorFilePort {
  return {
    readBinaryPreview: vi.fn<OfficeEditorFilePort["readBinaryPreview"]>(),
    stat: vi.fn<OfficeEditorFilePort["stat"]>(),
    writeBinaryFile: vi.fn<OfficeEditorFilePort["writeBinaryFile"]>(),
  };
}

describe("office-editor 文件和保存契约", () => {
  it("形状入口仍可组合插入、格式修改与读取，无反向聚合依赖", () => {
    const empty =
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>';
    const inserted = insertTextBox(empty, {
      x: 10,
      y: 20,
      width: 100,
      height: 200,
      text: "契约文字",
    });
    expect(inserted.name).toBeTruthy();
    const formatted = setShapeTextFormat(inserted.xml, inserted.name!, { bold: true, size: 24 });
    const shapes = readSlideShapes(formatted);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.textBodies[0]?.[0]?.lines).toEqual(["契约文字"]);
    expect(shapes[0]?.runFormat).toMatchObject({ bold: true, size: 24 });
  });

  it("宿主原样传入文件端口并接收派生脏标记", () => {
    const files = filePort();
    const onDirtyChange = vi.fn();
    const props = exampleOfficeEditorProps(files, "/workspace/example.pptx", onDirtyChange);
    expect(props.fileService).toBe(files);
    expect(props.path).toBe("/workspace/example.pptx");
    props.onDirtyChange?.(true);
    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it("DOCX 损坏包无法通过真实格式护栏", async () => {
    const result = await validateDocxCandidate(new Uint8Array([1, 2, 3]).buffer);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("not-a-zip");
  });

  it("PPTX 未编辑部件必须逐字节保留", async () => {
    const source = await deck();
    const changed = await JSZip.loadAsync(source);
    changed.file("ppt/media/image.png", new Uint8Array([9]));
    const result = await validatePptxCandidate(
      await changed.generateAsync({ type: "arraybuffer" }),
      source,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "part-modified")).toBe(true);
  });

  it("PPTX 产物丢失正文时在写端口前拒绝保存", async () => {
    const files = filePort();
    const result = await savePptxDocument({
      fileService: files,
      path: "/workspace/example.pptx",
      source: await deck(),
      baseline: new Map([[slideName, slideXml]]),
      current: new Map([[slideName, slideXml.replace("原始正文内容", "")]]),
      revision: null,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ kind: "validation" });
    expect(files.writeBinaryFile).not.toHaveBeenCalled();
  });

  it("真实保存流水线传递版本和备份要求，冲突仍返回失败", async () => {
    const files = filePort();
    vi.mocked(files.writeBinaryFile).mockRejectedValue(new Error("File revision mismatch"));
    const revision = { size: 100, mtimeMs: 50 };
    const result = await savePptxDocument({
      fileService: files,
      path: "/workspace/example.pptx",
      source: await deck(),
      baseline: new Map([[slideName, slideXml]]),
      current: new Map([[slideName, slideXml]]),
      revision,
    });
    expect(files.writeBinaryFile).toHaveBeenCalledExactlyOnceWith({
      path: "/workspace/example.pptx",
      dataBase64: expect.any(String),
      expectedRevision: revision,
      backup: "sibling",
    });
    expect(result).toEqual({ ok: false, kind: "conflict" });
  });
});
