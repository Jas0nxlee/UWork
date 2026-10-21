/**
 * PPTX 编辑位的**生命周期**（对应 Word 的 useOfficeDocument / Excel 的 useExcelDocument）。
 *
 * 与那两个同口径：远端先探写能力；保存是显式的、带版本比对与 sibling 备份；产物校验不过不写盘。
 * 差别在**保真策略**：不做"整份重写"，只在源 zip 上替换被改过的那几张幻灯片 XML，其余部件逐字节保留。
 */
import type { OfficeEditorFilePort } from "./contract.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { openPptxDocumentForEdit } from "./pptOpen.js";
import { savePptxDocument } from "./pptSave.js";
import { patchPictureBytes, patchTableXml } from "./pptInsertActions.js";
import { buildPreviewBytes, composeCurrentSlides, readSlidePart } from "./pptDeckCompose.js";
import { readDeckSlides, readSlideText, type PptxSlide } from "./pptText.js";
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

/** 应用内编辑的体积上限（pptx 是压缩包，60 MB 的 deck 解出来通常十几倍）。 */
export const MAX_EDITABLE_PPTX_BYTES = 60 * 1024 * 1024;

export type PptxEditKey = string;

export function editKey(partName: string, blockIndex: number): PptxEditKey {
  return `${partName}#${blockIndex}`;
}

export interface UsePptxDocumentInput {
  fileService: OfficeEditorFilePort;
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
  /** 每改一次 XML 就 +1：界面靠它重算（画布也拿它当重画 key）。 */
  const [revision, setRevision] = useState(0);
  /** 画布要渲染的字节 = 当前状态（渲染器接整份文件，而改动只在 XML 映射里，所以每改一次重算一份）。 */
  const [previewBytes, setPreviewBytes] = useState<ArrayBuffer | null>(null);

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
      const opened = await openPptxDocumentForEdit({
        maxBytes: MAX_EDITABLE_PPTX_BYTES,
        fileService,
        path,
        remote,
      });
      if (!opened.ok) {
        if (opened.blocked) setWriteBlocked(opened.blocked);
        setStatus(opened.reason);
        return;
      }
      revisionRef.current = opened.revision;
      const raw = opened.raw;
      sourceRef.current = raw;
      setPreviewBytes(raw.slice(0));
      previewBuildsRef.current += 1;
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
      const summary = ` · 文字可编辑，版式、图片、动画、母版原样保留 · 点「保存到文件」写回`;
      setStatus(`已载入 ${deck.slides.length} 张幻灯片 / ${blocks} 个文本块${summary}`);
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

  /** 当前状态（各页 XML + 文字改动）：保存与画布渲染共用同一份口径。 */
  const composeCurrent = useCallback(
    () => composeCurrentSlides(currentXmlRef.current, editsRef.current),
    [],
  );

  /** 预览重算次数与最后一次错误（挂在调试口子上，排查"改了画布没动"）。 */
  const previewBuildsRef = useRef(0);
  const previewErrorRef = useRef<string | null>(null);

  /** 重算画布要渲染的字节（只替换改过的页，其余部件逐字节保留）。 */
  const refreshPreview = useCallback(async () => {
    const source = sourceRef.current;
    if (!source) return;
    const bytes = await buildPreviewBytes({
      source,
      baseline: baselineXmlRef.current,
      current: composeCurrent(),
    });
    if (bytes) {
      previewBuildsRef.current += 1;
      previewErrorRef.current = null;
      setPreviewBytes(bytes);
      return;
    }
    previewErrorRef.current = "buildPreviewBytes 返回空";
    // 失败不要静默：否则画布会一直显示旧内容，看起来像"改了没反应"（真机踩过）
    setStatus("预览重算失败：画布上可能还是改动前的样子，请「重新加载」再试");
  }, [composeCurrent]);

  /** 对某张幻灯片的 XML 做一次补丁（形状/格式/层级都在这里落地）。 */
  const patchSlideXml = useCallback(
    (partName: string, patch: (xml: string) => string, label: string) => {
      const before = currentXmlRef.current.get(partName);
      if (before === undefined) return;
      const after = patch(before);
      if (after === before) {
        // 写完等于没写：**说出来**，别静默（真机上"点了没反应"最难查；也让点测能区分
        // "命令没跑到" 与 "跑到但值已经是这样"）
        setStatus(`${label}：这一页没有实际变化（值已经是这样了）`);
        return;
      }
      currentXmlRef.current.set(partName, after);
      setRevision((value) => value + 1);
      setDirty(true);
      setStatus(`${label}（保存时只写回这一页）`);
      void refreshPreview();
    },
    [refreshPreview, setDirty, setStatus],
  );

  /** 幻灯片级操作：直接对整份文件做补丁，然后把新的部件内容读回来。 */
  const applyDeckPatch = useCallback(
    async (patch: (source: ArrayBuffer) => Promise<ArrayBuffer>, label: string) => {
      const source = sourceRef.current;
      if (!source || busy) return;
      setBusy(true);
      try {
        // 补丁**之前**各页的 XML：下面要用它判断"这次补丁改了哪几页"
        const previous = await readSlideOrder(source);
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
        // 基线要跟着补丁前移：**新增的页**以当前内容为基线；**被补丁改过的页**也要前移，
        // 否则 (source, baseline) 两边不一致——source 已经是改后的、baseline 还是改前的，
        // 之后一次"改回原样"的编辑会被差分当成"没变"而跳过写回，zip 里就留住了补丁版本
        // （真机踩过：插了图片再删掉，画布上那张图还在）。
        const nextBaseline = new Map(baselineXmlRef.current);
        for (const [name, xml] of parts) {
          const before = previous.parts.get(name);
          if (before === undefined || before !== xml) nextBaseline.set(name, xml);
        }
        baselineXmlRef.current = nextBaseline;
        currentXmlRef.current = parts;
        sourceRef.current = next;
        setSlides(slides);
        setRevision((value) => value + 1);
        setDirty(true);
        setStatus(`${label}（${slides.length} 页）· 点「保存到文件」写回`);
        void refreshPreview();
      } catch (error) {
        setStatus(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, readSlideText, refreshPreview, setBusy, setDirty, setStatus],
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
  /** 插表格：只改这一页 XML（不像图片要动包）→ 普通补丁通道。 */
  const patchTable = useCallback(
    (partName: string, rows: number, cols: number, w: number, h: number) =>
      patchSlideXml(
        partName,
        (xml) => patchTableXml(xml, rows, cols, w, h),
        `插入 ${rows}×${cols} 表格`,
      ),
    [patchSlideXml],
  );

  /** 插图片：媒体部件、rels、p:pic 都是包级手术 → deck 补丁（逐字节保真不变）。 */
  const insertPictureAction = useCallback(
    (partName: string, dataUri: string, pageWidth: number, pageHeight: number) =>
      applyDeckPatch(
        (source) => patchPictureBytes(source, { partName, dataUri, pageWidth, pageHeight }),
        "插入图片",
      ),
    [applyDeckPatch],
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
      void refreshPreview();
    },
    [refreshPreview, setDirty, slides],
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
      const current = composeCurrent();
      const result = await savePptxDocument({
        fileService,
        path,
        source,
        baseline: baselineXmlRef.current,
        current,
        revision: revisionRef.current,
      });
      if (!result.ok) {
        setStatus(
          result.kind === "conflict"
            ? "保存被拒：文件已被其它程序（可能是 Agent）修改。请「重新加载」或另存副本后再改。"
            : result.kind === "validation"
              ? `已拒绝写入：产物没通过校验 —— ${result.issues.join("；")}（文稿仍在编辑器里，未保存）`
              : `保存失败：${result.message}`,
        );
        return;
      }
      // 保存成功后基线前移：否则第二次保存会把上一次的改动再写一遍
      revisionRef.current = result.revision;
      baselineXmlRef.current = current;
      currentXmlRef.current = new Map(current);
      sourceRef.current = result.bytes.slice(0);
      editsRef.current = new Map();
      setDirty(false);
      void refreshPreview();
      const backup = result.backupName ? ` · 备份 ${result.backupName}` : "";
      setStatus(
        `已保存到 ${path} · ${Math.round(result.megabytes / 1024)} KiB${backup} · 改了 ${result.changedSlides.length} 张幻灯片`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, composeCurrent, fileService, path, refreshPreview, setDirty, setStatus]);

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
    previewBytes,
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
    insertPictureAction,
    patchTable,
    /** 调试三件套：预览重算次数/错误、当前喂给渲染器的字节、模型里某页的 XML。 */
    previewBuilds: () => previewBuildsRef.current,
    previewError: () => previewErrorRef.current,
    rawPreviewBytes: previewBytes,
    modelXml: (partName: string) => currentXmlRef.current.get(partName) ?? null,
    duplicateSlideAction,
    deleteSlideAction,
    moveSlideAction,
  };
}
