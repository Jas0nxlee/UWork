/**
 * PPTX 编辑位的**生命周期**（对应 Word 的 useOfficeDocument / Excel 的 useExcelDocument）。
 *
 * 与那两个同口径：远端先探写能力；保存是显式的、带版本比对与 sibling 备份；产物校验不过不写盘。
 * 差别在**保真策略**：这里不做"差分写回工作簿"，而是**只在源 zip 上替换被改过的那几张幻灯片 XML**，
 * 其余部件逐字节保留（图片/母版/版式/动画/备注都不动）——校验里有一条专门盯这件事。
 */
import type { IFileService } from "@zcode/services";
import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToArrayBuffer, bytesToBase64 } from "./binary.js";
import { probeWriteSupport } from "./fileWriteSupport.js";
import {
  patchTxBody,
  readDeckSlides,
  readSlideText,
  writeDeckSlides,
  type PptxSlide,
} from "./pptText.js";
import {
  deleteShape as applyDeleteShape,
  duplicateShape as applyDuplicateShape,
  insertTextBox as applyInsertTextBox,
  moveShapeZ as applyMoveShapeZ,
  readSlideShapes,
  setShapeBounds as applyShapeBounds,
  setShapeParagraphFormat as applyShapeParagraph,
  setShapeTextFormat as applyShapeFormat,
  type PptxShape,
  type ShapeBounds,
  type ShapeRunFormat,
} from "./pptShapes.js";
import { addSlide, deleteSlide, duplicateSlide, moveSlide, readSlideOrder } from "./pptSlides.js";
import { validatePptxCandidate } from "./pptxValidate.js";

/** 应用内编辑的体积上限（pptx 是压缩包，60 MB 的 deck 解出来通常十几倍）。 */
export const MAX_EDITABLE_PPTX_BYTES = 60 * 1024 * 1024;

export type PptxEditKey = string;

/** 读 zip 里某个部件（幻灯片级操作之后用它把新的页读回来）。 */
async function readSlidePart(bytes: ArrayBuffer, partName: string): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(bytes.slice(0));
  return (await zip.file(partName)?.async("string")) ?? "";
}

export function editKey(partName: string, blockIndex: number): PptxEditKey {
  return `${partName}#${blockIndex}`;
}

export interface UsePptxDocumentInput {
  fileService: IFileService;
  path: string;
  remote?: boolean;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export function usePptxDocument(input: UsePptxDocumentInput) {
  const { fileService, path, remote, onDirtyChange } = input;
  const [status, setStatus] = useState("正在打开演示文稿…");
  const [slides, setSlides] = useState<PptxSlide[] | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState<string | null>(null);
  /**
   * 每改一次 XML 就 +1：形状/幻灯片改动**不经过 React state**（XML 在 ref 里），
   * 界面上的"形状列表/幻灯片文本"要靠这个版本号重算，否则列表是旧的（实测：新建文本框点了没出现）。
   */
  const [revision, setRevision] = useState(0);

  const sourceRef = useRef<ArrayBuffer | null>(null);
  const revisionRef = useRef<{ size: number; mtimeMs: number } | null>(null);
  /** 打开时的幻灯片 XML（保存时的差异基线）。 */
  const baselineXmlRef = useRef<Map<string, string>>(new Map());
  /** 当前每张幻灯片的 XML（形状/幻灯片改动都落在这里，保存时与基线比对）。 */
  const currentXmlRef = useRef<Map<string, string>>(new Map());
  /** 用户改过的文本块：key → 当前行数组。 */
  const editsRef = useRef<Map<PptxEditKey, string[]>>(new Map());

  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const setDirty = useCallback((value: boolean) => {
    setDirtyState(value);
    onDirtyChangeRef.current?.(value);
  }, []);

  const loadDocument = useCallback(async () => {
    setReady(false);
    setStatus("正在打开演示文稿…");
    setSlides(null);
    setDirty(false);
    editsRef.current = new Map();
    try {
      const [preview, fileStat] = await Promise.all([
        fileService.readBinaryPreview({ path }),
        fileService.stat({ path }),
      ]);
      revisionRef.current =
        typeof fileStat.mtimeMs === "number"
          ? { size: preview.totalBytes, mtimeMs: fileStat.mtimeMs }
          : null;
      if (remote) {
        const probe = await probeWriteSupport(fileService, path);
        if (!probe.supported) {
          setWriteBlocked(probe.reason ?? "服务端不支持写回");
          setStatus(`远端工作区不支持应用内编辑：${probe.reason ?? "服务端不支持写回"}`);
          return;
        }
        setWriteBlocked(null);
      }
      if (preview.totalBytes > MAX_EDITABLE_PPTX_BYTES) {
        setStatus(
          `演示文稿过大（${Math.round(preview.totalBytes / 1048576)} MB），不在应用内编辑：请用只读预览。`,
        );
        return;
      }
      const raw = base64ToArrayBuffer(preview.dataBase64);
      sourceRef.current = raw;
      const deck = await readDeckSlides(raw);
      baselineXmlRef.current = deck.sourceXml;
      currentXmlRef.current = new Map(deck.sourceXml);
      // 放映顺序以 presentation.xml 的 sldIdLst 为准（文件名顺序可能与放映顺序不一致）
      const order = await readSlideOrder(raw);
      const ordered = order.entries
        .map((entry, index) => {
          const slide = deck.slides.find((item) => item.partName === entry.partName);
          return slide ? { ...slide, number: index + 1 } : null;
        })
        .filter((slide): slide is PptxSlide => slide !== null);
      setSlides(ordered.length > 0 ? ordered : deck.slides);
      setReady(true);
      const blocks = deck.slides.reduce((total, slide) => total + slide.blocks.length, 0);
      setStatus(
        `已载入 ${deck.slides.length} 张幻灯片 / ${blocks} 个文本块 · 文字可编辑，版式、图片、动画、母版原样保留 · 点「保存到文件」写回`,
      );
    } catch (error) {
      setStatus(`打开失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [fileService, path, remote, setDirty]);

  useEffect(() => {
    void loadDocument();
  }, [loadDocument]);

  /** 当前幻灯片里的形状（渲染检查器用；改动都走下面这些方法）。 */
  const shapesOf = useCallback((partName: string): PptxShape[] => {
    const xml = currentXmlRef.current.get(partName);
    return xml ? readSlideShapes(xml) : [];
  }, []);

  /** 对某张幻灯片的 XML 做一次补丁（形状/格式/层级都在这里落地）。 */
  const patchSlideXml = useCallback(
    (partName: string, patch: (xml: string) => string, label: string) => {
      const before = currentXmlRef.current.get(partName);
      if (before === undefined) return;
      const after = patch(before);
      if (after === before) return;
      currentXmlRef.current.set(partName, after);
      setRevision((value) => value + 1);
      setDirty(true);
      setStatus(`${label}（保存时只写回这一页）`);
    },
    [setDirty, setStatus],
  );

  /** 幻灯片级操作：直接对整份文件做补丁，然后把新的部件内容读回来。 */
  const applyDeckPatch = useCallback(
    async (patch: (source: ArrayBuffer) => Promise<ArrayBuffer>, label: string) => {
      const source = sourceRef.current;
      if (!source || busy) return;
      setBusy(true);
      try {
        const next = await patch(source.slice(0));
        const order = await readSlideOrder(next);
        const parts = new Map<string, string>();
        for (const entry of order.entries) {
          parts.set(entry.partName, await readSlidePart(next, entry.partName));
        }
        const slides: PptxSlide[] = [];
        for (const [index, entry] of order.entries.entries()) {
          const xml = parts.get(entry.partName) ?? "";
          slides.push({ partName: entry.partName, number: index + 1, blocks: readSlideText(xml) });
        }
        // 幻灯片增删之后，"基线"要跟着走：新增的页以它当前内容为基线（等于新页就是新写的），
        // 否则保存时会把它当成"用户改过"从而多写一遍。
        const nextBaseline = new Map(baselineXmlRef.current);
        for (const [name, xml] of parts) {
          if (!nextBaseline.has(name)) nextBaseline.set(name, xml);
        }
        baselineXmlRef.current = nextBaseline;
        currentXmlRef.current = parts;
        sourceRef.current = next;
        setSlides(slides);
        setRevision((value) => value + 1);
        setDirty(true);
        setStatus(`${label}（${slides.length} 页）· 点「保存到文件」写回`);
      } catch (error) {
        setStatus(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, readSlideText, setBusy, setDirty, setStatus],
  );

  /** 改形状几何。 */
  const setShapeBounds = useCallback(
    (partName: string, shapeName: string, bounds: Partial<ShapeBounds>) =>
      patchSlideXml(
        partName,
        (xml) => applyShapeBounds(xml, shapeName, bounds),
        `调整「${shapeName}」的位置/大小`,
      ),
    [patchSlideXml],
  );
  /** 改形状文字格式。 */
  const setShapeFormat = useCallback(
    (partName: string, shapeName: string, format: ShapeRunFormat) =>
      patchSlideXml(
        partName,
        (xml) => applyShapeFormat(xml, shapeName, format),
        `修改「${shapeName}」的文字格式`,
      ),
    [patchSlideXml],
  );
  /** 改段落对齐/项目符号。 */
  const setShapeParagraph = useCallback(
    (
      partName: string,
      shapeName: string,
      format: { align?: "left" | "center" | "right" | "justify"; bullet?: boolean },
    ) =>
      patchSlideXml(
        partName,
        (xml) => applyShapeParagraph(xml, shapeName, format),
        `修改「${shapeName}」的段落格式`,
      ),
    [patchSlideXml],
  );
  /** 形状层级 / 复制 / 删除 / 新建文本框。 */
  const moveShape = useCallback(
    (partName: string, shapeName: string, direction: "up" | "down") =>
      patchSlideXml(
        partName,
        (xml) => applyMoveShapeZ(xml, shapeName, direction),
        `调整「${shapeName}」的层级`,
      ),
    [patchSlideXml],
  );
  const duplicateShape = useCallback(
    (partName: string, shapeName: string) =>
      patchSlideXml(
        partName,
        (xml) => applyDuplicateShape(xml, shapeName).xml,
        `复制「${shapeName}」`,
      ),
    [patchSlideXml],
  );
  const removeShape = useCallback(
    (partName: string, shapeName: string) =>
      patchSlideXml(partName, (xml) => applyDeleteShape(xml, shapeName), `删除「${shapeName}」`),
    [patchSlideXml],
  );
  const addTextBox = useCallback(
    (partName: string) =>
      patchSlideXml(
        partName,
        (xml) =>
          applyInsertTextBox(xml, {
            // 默认放在页面中部偏下，尺寸接近"一句话标题"
            x: 914400,
            y: 3 * 914400,
            width: 6 * 914400,
            height: 914400,
            text: "双击编辑文字",
          }).xml,
        "新建文本框",
      ),
    [patchSlideXml],
  );
  const addSlideAction = useCallback(
    () => applyDeckPatch((source) => addSlide({ source }), "新建幻灯片"),
    [applyDeckPatch],
  );
  const duplicateSlideAction = useCallback(
    (partName: string) =>
      applyDeckPatch((source) => duplicateSlide({ source, partName }), "复制幻灯片"),
    [applyDeckPatch],
  );
  const deleteSlideAction = useCallback(
    (partName: string) =>
      applyDeckPatch((source) => deleteSlide({ source, partName }), "删除幻灯片"),
    [applyDeckPatch],
  );
  const moveSlideAction = useCallback(
    (partName: string, to: number) =>
      applyDeckPatch((source) => moveSlide({ source, partName, to }), "调整幻灯片顺序"),
    [applyDeckPatch],
  );

  /** 界面上改一行：记进 edits，并标脏。 */
  const setBlockLines = useCallback(
    (partName: string, blockIndex: number, lines: string[]) => {
      const key = editKey(partName, blockIndex);
      const baselineLines = slides
        ?.find((slide) => slide.partName === partName)
        ?.blocks.find((block) => block.index === blockIndex)?.lines;
      const changed = !baselineLines || baselineLines.join("\n") !== lines.join("\n");
      if (changed) editsRef.current.set(key, lines);
      else editsRef.current.delete(key);
      setSlides((current) =>
        current
          ? current.map((slide) =>
              slide.partName === partName
                ? {
                    ...slide,
                    blocks: slide.blocks.map((block) =>
                      block.index === blockIndex ? { ...block, lines } : block,
                    ),
                  }
                : slide,
            )
          : current,
      );
      setDirty(editsRef.current.size > 0);
    },
    [setDirty, slides],
  );

  const save = useCallback(async () => {
    if (busy) return;
    const source = sourceRef.current;
    if (!source) {
      setStatus("演示文稿还没加载好，稍等一下再保存");
      return;
    }
    if (editsRef.current.size === 0) {
      setStatus("没有检测到文字改动，未写盘");
      setDirty(false);
      return;
    }
    setBusy(true);
    try {
      setStatus(`写回中（${editsRef.current.size} 处文字改动）…`);
      // 起点是"当前状态"（形状/幻灯片改动已经落在里面），文字改动再叠上去
      const current = new Map(currentXmlRef.current);
      for (const [key, lines] of editsRef.current) {
        const [partName, indexText] = key.split("#");
        if (!partName || indexText === undefined) continue;
        const xml = current.get(partName);
        if (xml === undefined) continue;
        current.set(partName, patchTxBody(xml, Number(indexText), lines));
      }
      const written = await writeDeckSlides({
        source,
        baseline: baselineXmlRef.current,
        current,
      });
      const validation = await validatePptxCandidate(written.bytes, source, {
        editedSlides: written.changedSlides,
      });
      if (!validation.ok) {
        setStatus(
          `已拒绝写入：产物没通过校验 —— ${validation.issues
            .map((issue) => issue.message)
            .join("；")}（文稿仍在编辑器里，未保存）`,
        );
        return;
      }
      const bytes = new Uint8Array(written.bytes);
      const result = await fileService.writeBinaryFile({
        path,
        dataBase64: bytesToBase64(bytes),
        ...(revisionRef.current ? { expectedRevision: revisionRef.current } : {}),
        backup: "sibling",
      });
      revisionRef.current = result.revision;
      // 保存后基线前移：否则第二次保存会把上一次的改动再写一遍
      baselineXmlRef.current = current;
      currentXmlRef.current = new Map(current);
      sourceRef.current = written.bytes.slice(0);
      editsRef.current = new Map();
      setDirty(false);
      const backupName = result.backup ? result.backup.split("/").pop() : "";
      setStatus(
        `已保存到 ${path} · ${Math.round(result.bytes / 1024)} KiB${backupName ? ` · 备份 ${backupName}` : ""} · 只改了 ${written.changedSlides.length} 张幻灯片的文字`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(
        message.includes("revision mismatch")
          ? "保存被拒：文件已被其它程序（可能是 Agent）修改。请「重新加载」或另存副本后再改。"
          : `保存失败：${message}`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, fileService, path, setDirty]);

  return {
    status,
    setStatus,
    slides,
    dirty,
    busy,
    ready,
    writeBlocked,
    loadDocument,
    save,
    revision,
    setBlockLines,
    editedCount: editsRef.current.size,
    shapesOf,
    setShapeBounds,
    setShapeFormat,
    setShapeParagraph,
    moveShape,
    duplicateShape,
    removeShape,
    addTextBox,
    addSlideAction,
    duplicateSlideAction,
    deleteSlideAction,
    moveSlideAction,
  };
}
