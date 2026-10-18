/**
 * 左栏：**幻灯片缩略图面板**（PowerPoint 那种）。
 *
 * 顶部一行是幻灯片级操作（新建 / 复制 / 删除 / 上移 / 下移），下面是真缩略图列表：
 * 当前页高亮、每页带页码、只画进入视口的那些。
 */
import { PptxSlideThumb } from "./PptxSlideThumb.js";
import type { PptxSlide } from "./pptText.js";
import type { PptxPreviewState } from "./usePptxPreview.js";

const smallButton =
  "rounded border border-border px-2 py-1 text-[11px] hover:border-accent disabled:opacity-40";

export interface PptxSlideThumbnailsProps {
  slides: PptxSlide[];
  preview: PptxPreviewState;
  activeSlide: number;
  busy: boolean;
  onSelectSlide: (index: number) => void;
  onAdd: () => void;
  onDuplicate: (partName: string) => void;
  onDelete: (partName: string) => void;
  onMove: (partName: string, to: number) => void;
  /** 收起面板（把宽度让给画布）。 */
  onCollapse: () => void;
  /** 嵌在浮层里：不要再画自己的边框/底部计数（外面那层已经画了）。 */
  embedded?: boolean;
}

export function PptxSlideThumbnails({
  slides,
  preview,
  activeSlide,
  busy,
  onSelectSlide,
  onAdd,
  onDuplicate,
  onDelete,
  onMove,
  onCollapse,
  embedded,
}: PptxSlideThumbnailsProps) {
  const slide = slides[activeSlide];
  return (
    <div
      className={`flex flex-col ${embedded ? "min-h-0 flex-1" : "w-44 shrink-0 border-r border-border"}`}
      data-pptx-slide-panel
    >
      <div className="flex flex-col gap-1 border-b border-border p-1">
        <div className="flex justify-end">
          <button
            type="button"
            data-pptx-thumbs-close
            className="rounded px-1 text-[11px] text-foreground-subtle hover:text-foreground"
            onClick={onCollapse}
            title="收起缩略图（把宽度让给画布）"
          >
            ‹
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            data-slide-add
            className={smallButton}
            disabled={busy}
            onClick={onAdd}
          >
            ＋ 新页
          </button>
          <button
            type="button"
            data-slide-duplicate
            className={smallButton}
            disabled={busy || !slide}
            onClick={() => slide && onDuplicate(slide.partName)}
          >
            复制
          </button>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            data-slide-delete
            className={smallButton}
            disabled={busy || !slide || slides.length <= 1}
            onClick={() => slide && onDelete(slide.partName)}
          >
            删除
          </button>
          <button
            type="button"
            data-slide-up
            className={smallButton}
            disabled={busy || activeSlide === 0}
            onClick={() => slide && onMove(slide.partName, activeSlide - 1)}
            title="上移一页"
          >
            ↑
          </button>
          <button
            type="button"
            data-slide-down
            className={smallButton}
            disabled={busy || activeSlide >= slides.length - 1}
            onClick={() => slide && onMove(slide.partName, activeSlide + 1)}
            title="下移一页"
          >
            ↓
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {slides.map((item, index) => (
          <PptxSlideThumb
            key={item.partName}
            preview={preview}
            pageIndex={preview.pageIndexOf(item.partName, index)}
            width={116}
            active={index === activeSlide}
            onSelect={() => onSelectSlide(index)}
          />
        ))}
      </div>
      <div className="border-t border-border px-2 py-1 text-[10px] text-foreground-subtlest">
        共 {slides.length} 页
      </div>
    </div>
  );
}
