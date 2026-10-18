/**
 * 画布底部的**缩放条**（PowerPoint 右下角那一套：− 百分比 ＋ 适应 档位）+ 「设置形状格式」入口。
 *
 * 单独成文件的两个理由：画布组件要守 400 行；这块是纯粹的控件，与几何换算无关。
 */
const ZOOM_PRESETS = [50, 75, 100, 150, 200];

export interface PptxCanvasZoomBarProps {
  zoom: number;
  onZoomChange: (updater: (value: number) => number) => void;
  onOpenFormatPane: () => void;
}

const buttonClass = "rounded border border-border px-1.5 py-0.5 hover:border-accent";

export function PptxCanvasZoomBar({
  zoom,
  onZoomChange,
  onOpenFormatPane,
}: PptxCanvasZoomBarProps) {
  const rounded = Math.round(zoom);
  return (
    <div className="flex shrink-0 items-center gap-1 text-[11px] text-foreground-subtle">
      <button
        type="button"
        data-pptx-open-format
        className="rounded border border-border px-2 py-0.5 hover:border-accent"
        onClick={onOpenFormatPane}
        title="打开右侧「设置形状格式」窗格"
      >
        设置形状格式
      </button>
      <button
        type="button"
        data-pptx-zoom-out
        className={buttonClass}
        onClick={() => onZoomChange((value) => Math.max(25, value - 25))}
        title="缩小"
      >
        −
      </button>
      <span data-pptx-zoom-value className="w-10 text-center tabular-nums">
        {`${rounded}%`}
      </span>
      <button
        type="button"
        data-pptx-zoom-in
        className={buttonClass}
        onClick={() => onZoomChange((value) => Math.min(400, value + 25))}
        title="放大"
      >
        ＋
      </button>
      <button
        type="button"
        data-pptx-zoom-fit
        className={buttonClass}
        onClick={() => onZoomChange(() => 100)}
        title="适应窗口（整页可见；Ctrl/⌘ + 滚轮也能缩放）"
      >
        适应窗口
      </button>
      <select
        data-pptx-zoom-presets
        className="rounded border border-border bg-background px-1 py-0.5"
        value={ZOOM_PRESETS.includes(rounded) ? String(rounded) : ""}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && next > 0) onZoomChange(() => next);
        }}
      >
        <option value="">缩放</option>
        {ZOOM_PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {preset}%
          </option>
        ))}
      </select>
    </div>
  );
}
