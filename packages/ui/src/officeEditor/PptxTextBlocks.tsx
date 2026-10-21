/**
 * 右栏「文本」分组：这一页的文本块（形状与表格单元格）逐块编辑。
 *
 * 为什么不直接就在画布上改字：画布上的就地编辑是下一步（PowerPoint 的做法），
 * 这排文本框是**兜底**——表格单元格、画布上点不准的小字、以及脚本/无障碍路径都靠它。
 * 每个 textarea 记一份 DOM 引用，画布双击形状时由编辑位把焦点移过来。
 */
import type { PptxSlide } from "./pptText.js";

export interface PptxTextBlocksProps {
  slide: PptxSlide | undefined;
  /** 注册 textarea（供"双击形状 → 聚焦到它的文字"用）。 */
  registerRef: (index: number, element: HTMLTextAreaElement | null) => void;
  onChange: (index: number, lines: string[]) => void;
}

export function PptxTextBlocks({ slide, registerRef, onChange }: PptxTextBlocksProps) {
  const blocks = slide?.blocks ?? [];
  if (blocks.length === 0) {
    return (
      <div className="py-2 text-[11px] text-foreground-subtlest">
        这一页没有可编辑的文字（可能整页都是图片）
      </div>
    );
  }
  return (
    <div>
      {blocks.map((block) => (
        <div key={`${slide?.partName ?? ""}#${block.index}`} className="pb-2">
          <div className="pb-1 text-[10px] text-foreground-subtle">
            文本 {block.index + 1} · {block.label}
          </div>
          <textarea
            data-pptx-block={`${slide?.partName}#${block.index}`}
            ref={(element) => registerRef(block.index, element)}
            className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-[12px] leading-relaxed"
            rows={Math.min(8, Math.max(2, block.lines.length + 1))}
            value={block.lines.join("\n")}
            onChange={(event) => onChange(block.index, event.target.value.split("\n"))}
          />
        </div>
      ))}
    </div>
  );
}
