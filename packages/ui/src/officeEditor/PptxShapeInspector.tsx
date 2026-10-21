/**
 * PPTX 编辑位的**检查器**：选中形状之后的"位置大小 / 文字格式 / 段落 / 层级 / 增删"。
 *
 * 与 PPT 的观感对齐：左边是幻灯片，右边是形状列表，下面是选中形状的属性面板。
 * 尺寸单位用**厘米**（PPT 的界面上就是厘米）——XML 里是 EMU，1 厘米 = 360000 EMU。
 */
import { useState } from "react";
import type { PptxShape, ShapeBounds, ShapeRunFormat } from "./pptShapes.js";

/** EMU ↔ 厘米（PPT 界面的单位）。 */
const EMU_PER_CM = 360000;
const toCm = (emu: number): number => Math.round((emu / EMU_PER_CM) * 100) / 100;
const toEmu = (cm: number): number => Math.round(cm * EMU_PER_CM);

const TEXT_COLORS = [
  { label: "默认", value: "" },
  { label: "黑", value: "000000" },
  { label: "红", value: "D93025" },
  { label: "橙", value: "E8710A" },
  { label: "绿", value: "1E8E3E" },
  { label: "蓝", value: "1A73E8" },
  { label: "灰", value: "5F6368" },
];
const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 54, 66];

export interface ShapeInspectorProps {
  shape: PptxShape;
  onBounds: (bounds: Partial<ShapeBounds>) => void;
  onFormat: (format: ShapeRunFormat) => void;
  onParagraph: (format: {
    align?: "left" | "center" | "right" | "justify";
    bullet?: boolean;
  }) => void;
  onMoveZ: (direction: "up" | "down") => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** 有没有"文字/段落"两组（图片、表格没有；文本在编辑位的「文本」分组里改）。 */
  textTools?: boolean;
}

const buttonClass = "rounded border border-border px-2 py-1 text-xs hover:border-accent";

export function ShapeInspector({
  shape,
  onBounds,
  onFormat,
  onParagraph,
  onMoveZ,
  onDuplicate,
  onDelete,
  textTools = true,
}: ShapeInspectorProps) {
  const [draft, setDraft] = useState<Partial<Record<"x" | "y" | "width" | "height", string>>>({});
  const bounds = shape.bounds;
  const paragraph = shape.textBodies[0]?.[0];

  const commit = (key: "x" | "y" | "width" | "height") => {
    const value = draft[key];
    setDraft((current) => ({ ...current, [key]: undefined }));
    if (value === undefined) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onBounds({ [key]: toEmu(parsed) } as Partial<ShapeBounds>);
  };

  const field = (key: "x" | "y" | "width" | "height", label: string) => (
    <label className="flex items-center gap-1 text-[11px] text-foreground-subtle">
      {label}
      <input
        data-shape-field={key}
        className="w-16 rounded border border-border bg-background px-1 py-0.5 text-right text-xs text-foreground"
        value={draft[key] ?? String(toCm(bounds[key]))}
        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
        onBlur={() => commit(key)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(key);
        }}
      />
      cm
    </label>
  );

  return (
    <div
      className="border-t border-border bg-surface/40 px-3 py-2 text-xs"
      data-shape-inspector={shape.name}
    >
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <span className="font-medium">{shape.name || "(未命名)"}</span>
        <span className="text-foreground-subtle">
          {shape.kind === "sp" ? "文本框/形状" : shape.kind === "pic" ? "图片" : "表格"}
        </span>
        {field("x", "X")}
        {field("y", "Y")}
        {field("width", "宽")}
        {field("height", "高")}
      </div>
      {textTools ? (
        <>
          <div className="flex flex-wrap items-center gap-1 pb-2">
            <span className="pr-1 text-foreground-subtle">文字：</span>
            {(
              [
                ["加粗", "bold"],
                ["斜体", "italic"],
                ["下划线", "underline"],
                ["删除线", "strike"],
              ] as const
            ).map(([label, key]) => (
              <button
                key={key}
                type="button"
                data-shape-format={key}
                // **开关**而不是"设为开"：点第二次要能关掉（点测查出：早先写死 true，加粗永远关不掉）
                className={`${buttonClass} ${
                  shape.runFormat?.[key] ? "border-sky-500 bg-sky-500/10 text-sky-200" : ""
                }`}
                onClick={() => onFormat({ [key]: !shape.runFormat?.[key] })}
              >
                {label}
              </button>
            ))}
            <label className="flex items-center gap-1">
              字号
              <select
                data-shape-size
                className="rounded border border-border bg-background px-1 py-0.5 text-xs"
                defaultValue=""
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (value > 0) onFormat({ size: value });
                }}
              >
                <option value="">选择</option>
                {SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1">
              颜色
              <select
                data-shape-color
                className="rounded border border-border bg-background px-1 py-0.5 text-xs"
                defaultValue=""
                onChange={(event) => onFormat({ color: event.target.value })}
              >
                {TEXT_COLORS.map((color) => (
                  <option key={color.label} value={color.value}>
                    {color.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1 pb-2">
            <span className="pr-1 text-foreground-subtle">段落：</span>
            {(
              [
                ["left", "左"],
                ["center", "居中"],
                ["right", "右"],
                ["justify", "两端"],
              ] as const
            ).map(([align, label]) => (
              <button
                key={align}
                type="button"
                data-shape-align={align}
                className={buttonClass}
                onClick={() => onParagraph({ align })}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              data-shape-bullet="on"
              className={buttonClass}
              onClick={() => onParagraph({ bullet: true })}
            >
              项目符号
            </button>
            <button
              type="button"
              data-shape-bullet="off"
              className={buttonClass}
              onClick={() => onParagraph({ bullet: false })}
            >
              去符号
            </button>
            {paragraph?.align ? (
              <span className="text-foreground-subtlest">当前 {paragraph.align}</span>
            ) : null}
          </div>
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          data-shape-z="up"
          className={buttonClass}
          onClick={() => onMoveZ("up")}
        >
          上移一层
        </button>
        <button
          type="button"
          data-shape-z="down"
          className={buttonClass}
          onClick={() => onMoveZ("down")}
        >
          下移一层
        </button>
        <button type="button" data-shape-duplicate className={buttonClass} onClick={onDuplicate}>
          复制形状
        </button>
        <button
          type="button"
          data-shape-delete
          className="rounded border border-red-500/60 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
          onClick={onDelete}
        >
          删除形状
        </button>
      </div>
    </div>
  );
}
