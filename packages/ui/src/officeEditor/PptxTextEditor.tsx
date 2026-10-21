/**
 * 画布上的**就地文本编辑层**（PowerPoint 的双击改字）。
 *
 * 为什么要它：原来"双击形状"只是把焦点交给右侧窗格里的 textarea——那不是 PowerPoint 的手感：
 * 用户想看到**文字在原来的位置上**被改。这里在形状的位置上盖一个编辑层，字号/对齐/颜色/粗细
 * 都按这个形状现有的格式算（`a:rPr` 读回来的 `runFormat`），改完回车以外的地方/⌘↵ 提交。
 *
 * 几个刻意的取舍（写清楚，别当成 bug）：
 * - 编辑层**带白底**：渲染器画出来的原文就在下面，不盖住会看到两遍字。白色是"页面底色"，
 *   深色版式上会显得盖了一块白——比"两遍字"可接受，等渲染器支持"临时隐藏某个形状"再改。
 * - 单位换算：`sz` 是磅，渲染器是 96dpi 像素 → `px = 磅 × 4/3 × scale`，与形状里的字号看起来一致。
 * - Esc = 不保存退出，⌘/Ctrl + ↵ = 保存退出，点到别处 = 保存退出（Blur）。
 */
import { useEffect, useRef } from "react";
import { emuToPx, type CanvasBox } from "./pptCanvasGeometry.js";
import type { ShapeRunFormat } from "./pptShapes.js";

export interface PptxTextEditorProps {
  /** 形状几何（EMU）。 */
  box: CanvasBox;
  scale: number;
  format: ShapeRunFormat;
  align?: "left" | "center" | "right" | "justify";
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export function PptxTextEditor({
  box,
  scale,
  format,
  align,
  value,
  onChange,
  onCommit,
  onCancel,
}: PptxTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  /** 刚打开的时间点：双击的**第二下**会把刚聚焦的编辑层 blur 掉，那种 blur 不能当"提交"。 */
  const openedAt = useRef(Date.now());

  // 进编辑就聚焦、全选：PowerPoint 双击文本框也是先全选（接着打就替换）
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    openedAt.current = Date.now();
    node.focus();
    node.select();
  }, []);

  const points = typeof format.size === "number" && format.size > 0 ? format.size : 18;
  const fontSize = Math.max(9, points * (4 / 3) * scale);

  return (
    <textarea
      ref={ref}
      data-pptx-text-editor
      value={value}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => {
        // 双击/连点产生的瞬时 blur：重新聚焦继续编辑，别把编辑层关掉（真机实测：
        // 双击进编辑后立刻被自己的第二下点掉，看起来就是"双击没反应"）
        if (Date.now() - openedAt.current < 300 && ref.current) {
          ref.current.focus();
          return;
        }
        onCommit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onCommit();
        }
      }}
      // 编辑层里的按下不能触发画布的"选中 + 拖拽"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="resize-none"
      style={{
        position: "absolute",
        left: emuToPx(box.x, scale),
        top: emuToPx(box.y, scale),
        width: Math.max(60, emuToPx(box.width, scale)),
        height: Math.max(28, emuToPx(box.height, scale)),
        fontSize,
        lineHeight: 1.25,
        fontFamily: format.font ? `"${format.font}", var(--font-sans)` : undefined,
        fontWeight: format.bold ? 700 : 400,
        fontStyle: format.italic ? "italic" : "normal",
        textDecoration: [format.underline ? "underline" : "", format.strike ? "line-through" : ""]
          .filter(Boolean)
          .join(" "),
        color: format.color ?? "#111111",
        textAlign: align ?? "left",
        background: "#ffffff",
        outline: "2px solid rgb(14,165,233)",
        outlineOffset: -1,
        padding: 2,
        boxSizing: "border-box",
        overflow: "hidden",
        caretColor: "#111111",
      }}
    />
  );
}
