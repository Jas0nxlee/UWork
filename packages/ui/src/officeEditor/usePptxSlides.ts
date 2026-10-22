/**
 * **幻灯片级操作**：新建 / 复制 / 删除 / 调整顺序。
 *
 * 这些都是**包级手术**（新增或删除 `ppt/slides/slideN.xml`、动 `p:sldIdLst`、补 rels 与 Content_Types），
 * 所以走 `applyDeckPatch`：对整份文件打补丁 → 把各页 XML 读回来 → **基线跟着前移**
 * （新增的页以当前内容为基线；被补丁改过的页也前移——否则之后一次"改回原样"的编辑会被差分当成
 * "没变"而跳过写回，zip 里就留住了补丁版本，这条踩过）。
 *
 * 单独成 hook 的原因：编辑位那个文件要守 400 行。
 */
import { useCallback, type RefObject } from "react";
import { readSlidePart } from "./pptDeckCompose.js";
import { readDeckSlides, readSlideText, type PptxSlide } from "./pptText.js";
import { addSlide, deleteSlide, duplicateSlide, moveSlide, readSlideOrder } from "./pptSlides.js";

export interface PptxSlidesInput {
  sourceRef: RefObject<ArrayBuffer | null>;
  baselineRef: RefObject<Map<string, string>>;
  currentRef: RefObject<Map<string, string>>;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setSlides: (slides: PptxSlide[]) => void;
  bumpRevision: () => void;
  markDirty: () => void;
  setStatus: (message: string) => void;
  refreshPreview: () => void;
  /** 包变了要重收备注页（备注部件可能跟着新增/删除）。 */
  recollectNotes: (bytes: ArrayBuffer, slideParts: readonly string[]) => Promise<void>;
}

export function usePptxSlides(input: PptxSlidesInput) {
  const { sourceRef, baselineRef, currentRef, busy } = input;

  const applyDeckPatch = useCallback(
    async (patch: (source: ArrayBuffer) => Promise<ArrayBuffer>, label: string) => {
      const source = sourceRef.current;
      if (!source || busy) return;
      input.setBusy(true);
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
        // 基线要跟着补丁前移：新增的页以当前内容为基线；**被补丁改过的页也要**（见文件头注释）
        const nextBaseline = new Map(baselineRef.current);
        for (const [name, xml] of parts) {
          const before = previous.parts.get(name);
          if (before === undefined || before !== xml) nextBaseline.set(name, xml);
        }
        baselineRef.current = nextBaseline;
        currentRef.current = parts;
        sourceRef.current = next;
        input.setSlides(slides);
        input.bumpRevision();
        input.markDirty();
        input.setStatus(`${label}（${slides.length} 页）· 点「保存到文件」写回`);
        await input.recollectNotes(
          next,
          order.entries.map((entry) => entry.partName),
        );
        input.refreshPreview();
      } catch (error) {
        input.setStatus(`${label}失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        input.setBusy(false);
      }
    },
    [baselineRef, busy, currentRef, input, sourceRef],
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

  /** 幻灯片文本块数量（状态栏用）。 */
  const countBlocks = useCallback(
    (slides: PptxSlide[]) => slides.reduce((total, slide) => total + slide.blocks.length, 0),
    [],
  );

  return {
    applyDeckPatch,
    addSlideAction,
    duplicateSlideAction,
    deleteSlideAction,
    moveSlideAction,
    countBlocks,
  };
}

export { readDeckSlides };
