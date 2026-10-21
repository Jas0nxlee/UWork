/**
 * 右栏「设置形状格式」任务窗格：形状几何/文字格式/段落/层级/复制删除 + 形状列表 + 文本块。
 *
 * 单独成文件的两个理由：① 编辑位那个文件有 400 行上限；② 这个窗格在**窄容器里会变成浮层**
 * （见 `floating`）：编辑位在侧栏里只有几百像素宽，窗格再固定占 288px 会把画布挤到 100 多像素、
 * 没法用（真机实测：画布 182×137）。窄的时候它浮在画布上，宽的时候才占布局。
 */
import { useEffect, useState } from "react";
import { ShapeInspector } from "./PptxShapeInspector.js";
import { PptxTextBlocks } from "./PptxTextBlocks.js";
import type { PptxSlide } from "./pptText.js";
import type { PptxShape, ShapeBounds, ShapeRunFormat } from "./pptShapes.js";

export interface PptxFormatPaneProps {
  shape: PptxShape | null;
  slide: PptxSlide | undefined;
  shapes: PptxShape[];
  activeShape: string | null;
  /** 窄容器里变成浮层（盖在画布右上，带阴影） */
  floating: boolean;
  onSelectShape: (name: string) => void;
  onClose: () => void;
  onBounds: (bounds: Partial<ShapeBounds>) => void;
  onFormat: (format: ShapeRunFormat) => void;
  onParagraph: (format: {
    align?: "left" | "center" | "right" | "justify";
    bullet?: boolean;
  }) => void;
  onMoveZ: (direction: "up" | "down") => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAddTextBox: () => void;
  registerBlockRef: (index: number, element: HTMLTextAreaElement | null) => void;
  onChangeBlock: (index: number, lines: string[]) => void;
  /** 表格的网格线现状（选中表格时才有意义）。 */
  tableGrid?: boolean;
  /** 开/关整张表的网格线。 */
  onTableGrid?: (on: boolean) => void;
  /** 这一页的讲稿备注（没有备注部件时 text 为空、hasNotes=false）。 */
  notes: { text: string[]; hasNotes: boolean };
  onNotesChange: (lines: string[]) => void;
}

export function PptxFormatPane({
  shape,
  slide,
  shapes,
  activeShape,
  floating,
  onSelectShape,
  onClose,
  onBounds,
  onFormat,
  onParagraph,
  onMoveZ,
  onDuplicate,
  onDelete,
  onAddTextBox,
  registerBlockRef,
  onChangeBlock,
  tableGrid = false,
  onTableGrid,
  notes,
  onNotesChange,
}: PptxFormatPaneProps) {
  /** 备注按"一行一条"编辑；还没有备注时也给一个可输入的框。 */
  const notesLines = notes.text.length > 0 ? notes.text : [""];
  // 备注**失焦才提交**：每次按键都提交的话，改一个字就要把整包 zip 重写一遍（大 deck 会卡）。
  // PowerPoint 也是离开输入框才落盘；Esc 放弃这次编辑。
  const notesSaved = notesLines.join("\n");
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  useEffect(() => {
    setNotesDraft(null);
  }, [slide?.partName]);
  return (
    <div
      data-pptx-task-pane
      className={`flex flex-col overflow-y-auto border-border bg-background ${
        floating
          ? "absolute bottom-2 right-2 top-2 z-20 w-64 rounded border shadow-2xl"
          : "w-72 shrink-0 border-l"
      }`}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[11px] font-medium">设置形状格式</span>
        <button
          type="button"
          data-pptx-close-format
          className="rounded px-1 text-foreground-subtle hover:text-foreground"
          onClick={onClose}
          title="收起窗格（把画布让出来）"
        >
          ✕
        </button>
      </div>
      {shape && slide ? (
        <>
          {/* 按选中对象显示：文本框/形状给文字与段落，图片给图片信息，表格给"去哪改"的指引。
              （用户口径：选中什么就该看到什么设置，别拿形状的文字格式套在图片上） */}
          {shape.kind !== "sp" ? (
            <div
              className="border-b border-border px-3 py-2 text-[11px] text-foreground-subtle"
              data-pptx-kind-note={shape.kind}
            >
              {shape.kind === "pic"
                ? "这是一张图片：可以改位置、大小、层级，或复制/删除；图片的裁剪、亮度、替换还没做。"
                : "这是一个表格：在画布上点格子（按住拖可选中一片），顶部的「表格」标签里做增删行列、合并、对齐、底纹边框；格子里的文字在下面的「文本」里改。"}
            </div>
          ) : null}
          {shape.kind === "graphicFrame" && onTableGrid ? (
            <div className="border-b border-border px-3 py-2" data-pptx-table-settings>
              <label className="flex items-center gap-2 text-[11px]">
                <input
                  type="checkbox"
                  data-pptx-table-grid
                  checked={tableGrid}
                  onChange={(event) => onTableGrid(event.target.checked)}
                />
                网格线
                <span className="text-foreground-subtlest">
                  {tableGrid ? "整张表已有边框" : "整张表没有边框"}
                </span>
              </label>
            </div>
          ) : null}
          <ShapeInspector
            shape={shape}
            onBounds={onBounds}
            onFormat={onFormat}
            onParagraph={onParagraph}
            onMoveZ={onMoveZ}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            // 图片/表格没有文字格式可言：把文字与段落两组藏起来（表格的文字在下面的「文本」里改）
            textTools={shape.kind === "sp"}
          />
        </>
      ) : (
        <div className="px-3 py-2 text-[11px] text-foreground-subtlest">
          在画布上点一个形状，或从下面的形状列表里选一个，这里就会出现它的位置、大小与文字格式。
        </div>
      )}
      {slide ? (
        <div className="border-t border-border px-3 py-2">
          <div className="flex items-center justify-between pb-1">
            <span className="text-[11px] text-foreground-subtle">
              这一页的形状（也可以在画布上点）
            </span>
            <button
              type="button"
              data-shape-add-textbox
              className="rounded border border-border px-2 py-0.5 text-[11px] hover:border-accent"
              onClick={onAddTextBox}
            >
              ＋ 文本框
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {shapes.map((item) => (
              <button
                key={item.name}
                type="button"
                data-pptx-shape={item.name}
                className={`rounded border px-2 py-0.5 text-[11px] ${
                  item.name === activeShape
                    ? "border-sky-500 bg-sky-500/10 text-sky-200"
                    : "border-border hover:border-accent"
                }`}
                onClick={() => onSelectShape(item.name)}
              >
                {item.name || "(未命名)"}
                {item.kind === "pic" ? " ·图片" : item.kind === "graphicFrame" ? " ·表格" : ""}
              </button>
            ))}
            {shapes.length === 0 ? (
              <span className="text-[11px] text-foreground-subtlest">这一页没有可编辑形状</span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="border-t border-border px-3 py-2">
        <div className="flex items-center justify-between pb-1">
          <span className="text-[11px] font-medium">备注</span>
          <span className="text-[10px] text-foreground-subtlest">
            {notes.hasNotes ? "已保存进这一页" : "还没有备注"}
          </span>
        </div>
        <textarea
          data-pptx-notes
          className="mb-2 w-full resize-y rounded border border-border bg-background px-2 py-1 text-[12px] leading-relaxed"
          rows={3}
          placeholder="讲稿备注（放映时不显示）"
          value={notesDraft ?? notesSaved}
          onChange={(event) => setNotesDraft(event.target.value)}
          onBlur={() => {
            if (notesDraft !== null && notesDraft !== notesSaved)
              onNotesChange(notesDraft.split("\n"));
            setNotesDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setNotesDraft(null);
            event.currentTarget.blur();
          }}
        />
        <div className="border-t border-border pt-2 pb-1 text-[11px] font-medium">文本</div>
        <PptxTextBlocks slide={slide} registerRef={registerBlockRef} onChange={onChangeBlock} />
      </div>
    </div>
  );
}
