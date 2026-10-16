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
import { patchTxBody, readDeckSlides, writeDeckSlides, type PptxSlide } from "./pptText.js";
import { validatePptxCandidate } from "./pptxValidate.js";

/** 应用内编辑的体积上限（pptx 是压缩包，60 MB 的 deck 解出来通常十几倍）。 */
export const MAX_EDITABLE_PPTX_BYTES = 60 * 1024 * 1024;

export type PptxEditKey = string;

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

  const sourceRef = useRef<ArrayBuffer | null>(null);
  const revisionRef = useRef<{ size: number; mtimeMs: number } | null>(null);
  /** 打开时的幻灯片 XML（保存时的差异基线）。 */
  const baselineXmlRef = useRef<Map<string, string>>(new Map());
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
      setSlides(deck.slides);
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
      // 逐块把改动打到 XML 上：同一张幻灯片改多处时，后一处基于前一处的结果继续改
      const current = new Map(baselineXmlRef.current);
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
    setBlockLines,
    editedCount: editsRef.current.size,
  };
}
