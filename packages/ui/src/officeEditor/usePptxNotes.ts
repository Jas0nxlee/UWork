/**
 * 讲稿备注的**读写**（`ppt/notesSlides/notesSlideN.xml`）。
 *
 * 两件事：**读**某一页的备注；**写**（没有备注部件就先建一个——那是包级手术，见 `pptNotes.ts`）。
 * 单独成 hook 的原因：编辑位那个文件要守 400 行；这块也确实自成一摊（部件映射 + 备注 XML 缓存）。
 */
import { useCallback, type RefObject } from "react";
import { ensureNotesPart, readPartXml, readSlidePart, writePartIntoZip } from "./pptDeckCompose.js";
import { addNotesSlide, notesBodyIndex, notesPartOf, readNotesText } from "./pptNotes.js";
import { patchTxBody } from "./pptText.js";

export interface PptxNotesInput {
  sourceRef: RefObject<ArrayBuffer | null>;
  /** 幻灯片部件名 → 备注部件名。 */
  notesPartRef: RefObject<Map<string, string>>;
  /** 备注部件名 → 当前 XML（未保存的改动也在这里）。 */
  notesXmlRef: RefObject<Map<string, string>>;
  busy: boolean;
  setBusy: (value: boolean) => void;
  bumpRevision: () => void;
  markDirty: () => void;
  setStatus: (message: string) => void;
  refreshPreview: () => void;
}

export function usePptxNotes(input: PptxNotesInput) {
  const {
    sourceRef,
    notesPartRef,
    notesXmlRef,
    busy,
    setBusy,
    bumpRevision,
    markDirty,
    setStatus,
    refreshPreview,
  } = input;

  /** 打开文件时把每页的备注部件找出来并读进缓存（按"这一页的 rels"找，不猜文件名）。 */
  const collectNotes = useCallback(
    async (bytes: ArrayBuffer, slideParts: readonly string[]) => {
      notesPartRef.current = new Map();
      notesXmlRef.current = new Map();
      for (const slidePart of slideParts) {
        const part = await notesPartOf(bytes, slidePart);
        if (!part) continue;
        notesPartRef.current.set(slidePart, part);
        notesXmlRef.current.set(part, await readSlidePart(bytes, part));
      }
    },
    [notesPartRef, notesXmlRef],
  );

  /** 读某一页的备注（没有备注部件就是空数组）。 */
  const notesOf = useCallback(
    (slidePart: string): { text: string[]; hasNotes: boolean } => {
      if (!sourceRef.current) return { text: [], hasNotes: false };
      const part = notesPartRef.current.get(slidePart) ?? null;
      if (!part) return { text: [], hasNotes: false };
      return { text: readNotesText(notesXmlRef.current.get(part) ?? ""), hasNotes: true };
    },
    [notesPartRef, notesXmlRef, sourceRef],
  );

  /** 写某一页的备注：没有备注部件就先建一个（新建 notesSlide + rel + Content_Types 登记）。 */
  const saveNotes = useCallback(
    async (slidePart: string, lines: string[]) => {
      const source = sourceRef.current;
      if (!source || busy) return;
      setBusy(true);
      try {
        const part = await ensureNotesPart(
          source,
          slidePart,
          notesPartRef,
          addNotesSlide,
          (bytes) => {
            sourceRef.current = bytes;
          },
        );
        const xml =
          notesXmlRef.current.get(part) ?? (await readPartXml(sourceRef.current ?? source, part));
        const bodyIndex = notesBodyIndex(xml);
        const patched = bodyIndex === null ? xml : patchTxBody(xml, bodyIndex, lines);
        notesXmlRef.current.set(part, patched);
        // 备注改动落在**包**里（保存时与幻灯片一起只写回改过的部件）
        sourceRef.current = await writePartIntoZip(sourceRef.current ?? source, part, patched);
        bumpRevision();
        markDirty();
        setStatus(`备注已更新（${lines.filter(Boolean).length} 行）· 保存时只写回这一页的备注`);
        refreshPreview();
      } catch (error) {
        setStatus(`备注保存失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [
      bumpRevision,
      busy,
      markDirty,
      notesPartRef,
      notesXmlRef,
      refreshPreview,
      setBusy,
      setStatus,
      sourceRef,
    ],
  );

  return { collectNotes, notesOf, saveNotes };
}
