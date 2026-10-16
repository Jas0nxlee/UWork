/**
 * 功能区里的三种视图件：图标按钮 / 下拉 / 样式库。
 * 与 officeRibbonModel.ts 的数据一一对应；命令、参数形态的出处见该文件顶部注释。
 *
 * 布局自适应（2026-10-15，为用户反馈"侧栏窄时不适配"补）：本文件里的视图件都接受
 * `compact`（窄布局：下拉只留图标+当前值，去掉标签文字），按钮尺寸也随布局收缩。
 */
import {
  AlignLeft24Regular,
  AlignRight24Regular,
  ArrowRedo24Regular,
  ArrowUndo24Regular,
  CalendarLtr24Regular,
  CheckboxChecked24Regular,
  ClearFormatting24Regular,
  Code24Regular,
  ColumnTriple24Regular,
  Delete24Regular,
  DividerShort24Regular,
  DocumentFit24Regular,
  DocumentOnePage24Regular,
  DocumentPageBottomCenter24Regular,
  DocumentPageBreak24Regular,
  Eye24Regular,
  FontDecrease24Regular,
  FontIncrease24Regular,
  Highlight24Regular,
  Image24Regular,
  Link24Regular,
  LockClosed24Regular,
  MathFormula24Regular,
  PaintBrush24Regular,
  Print24Regular,
  Ruler24Regular,
  Search24Regular,
  TableDeleteRow24Regular,
  TableInsertColumn24Regular,
  TableInsertRow24Regular,
  TableSimple24Regular,
  TaskListSquareLtr24Regular,
  TextAlignCenter24Regular,
  TextAlignJustify24Regular,
  TextBold24Regular,
  TextBulletListLtr24Regular,
  TextColor24Regular,
  TextItalic24Regular,
  TextLineSpacing24Regular,
  TextNumberListLtr24Regular,
  TextQuote24Regular,
  TextStrikethrough24Regular,
  TextSubscript24Regular,
  TextSuperscript24Regular,
  TextUnderline24Regular,
  TextWordCount24Regular,
  ZoomIn24Regular,
  ZoomOut24Regular,
} from "@fluentui/react-icons";
import type { ComponentType } from "react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RibbonCommand, RibbonGallery, RibbonSelect, RibbonStyle } from "./officeRibbonModel.js";

export type RunCommand = (command: string, args?: unknown[]) => void;

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  ArrowUndo24Regular,
  ArrowRedo24Regular,
  PaintBrush24Regular,
  ClearFormatting24Regular,
  FontIncrease24Regular,
  FontDecrease24Regular,
  TextBold24Regular,
  TextItalic24Regular,
  TextUnderline24Regular,
  TextStrikethrough24Regular,
  TextSuperscript24Regular,
  TextSubscript24Regular,
  TextColor24Regular,
  Highlight24Regular,
  AlignLeft24Regular,
  TextAlignCenter24Regular,
  AlignRight24Regular,
  TextAlignJustify24Regular,
  TextLineSpacing24Regular,
  TextBulletListLtr24Regular,
  TextNumberListLtr24Regular,
  TaskListSquareLtr24Regular,
  TableSimple24Regular,
  Image24Regular,
  Link24Regular,
  MathFormula24Regular,
  CalendarLtr24Regular,
  CheckboxChecked24Regular,
  Code24Regular,
  TextQuote24Regular,
  DividerShort24Regular,
  DocumentPageBreak24Regular,
  DocumentPageBottomCenter24Regular,
  ColumnTriple24Regular,
  TableInsertRow24Regular,
  TableInsertColumn24Regular,
  TableDeleteRow24Regular,
  Delete24Regular,
  DocumentFit24Regular,
  ZoomOut24Regular,
  ZoomIn24Regular,
  Ruler24Regular,
  DocumentOnePage24Regular,
  Eye24Regular,
  LockClosed24Regular,
  TextWordCount24Regular,
  Search24Regular,
  Print24Regular,
};

export function iconOf(name: string | undefined): ComponentType<{ className?: string }> | undefined {
  return name ? ICONS[name] : undefined;
}

function isActive(command: string, args: unknown[] | undefined, style: RibbonStyle | null): boolean {
  if (!style) return false;
  if (command === "executeRowFlex") return style.rowFlex === args?.[0];
  if (command === "executeList") return style.listType === args?.[0];
  const map: Record<string, boolean | undefined> = {
    executeBold: style.bold,
    executeItalic: style.italic,
    executeUnderline: style.underline,
    executeStrikeout: style.strikeout,
    // 格式刷是模式开关；撤销/重做不是（可用性只体现在置灰）
    executePainter: style.painter,
  };
  return map[command] === true;
}

function isDisabled(command: string, style: RibbonStyle | null): boolean {
  if (!style) return false;
  if (command === "executeUndo") return style.undo === false;
  if (command === "executeRedo") return style.redo === false;
  return false;
}

/** 下拉项对应的命令（与 officeRibbonModel 的选项一一对应）。 */
export function optionsCommand(title: string): string {
  switch (title) {
    case "字体":
      return "executeFont";
    case "字号":
      return "executeSize";
    case "行距":
      return "executeRowMargin";
    case "项目符号与编号":
      return "executeList";
    case "文字颜色":
      return "executeColor";
    case "高亮（底纹）":
    case "单元格底色":
      return "executeHighlight";
    case "单元格垂直对齐":
      return "executeSetTableCellVerticalAlign";
    case "纸张大小":
      return "executePaperSize";
    case "纸张方向":
      return "executePaperDirection";
    case "页边距":
      return "executeSetPaperMargin";
    case "分栏":
      return "executeSetColumns";
    case "插入内容控件（文本/列举/复选/单选/日期/数字）":
      return "executeInsertControlByType";
    default:
      return "executeNoop";
  }
}


/**
 * 下拉面板：**传送到 body + fixed 定位**。
 *
 * 为什么不能用普通绝对定位：功能区的分组行有 `overflow-x-auto`，绝对定位的下拉会被祖先裁掉
 * （真机反馈"字体下拉被困在上面栏中"，截图里只剩两行）。传送到 body 后不受任何祖先的 overflow/transform 影响；
 * 位置按触发器的 rect 计算，并做视口内夹取与"下方放不下就翻到上方"。
 */
export function DropdownPanel({
  open,
  anchorRef,
  onClose,
  minWidth = 208,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  minWidth?: number;
  children: React.ReactNode;
}) {
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(minWidth, rect.width);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const panelHeight = 288;
      const below = rect.bottom + 4;
      const top = below + panelHeight <= window.innerHeight - 8 ? below : Math.max(8, rect.top - panelHeight - 4);
      setPosition({ left, top, width });
    };
    measure();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if ((event.target as HTMLElement)?.closest?.("[data-ribbon-dropdown]")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    // 面板打开时若容器滚动，关闭它（避免面板与触发器错位）
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [anchorRef, minWidth, onClose, open]);
  if (!open || !position) return null;
  return createPortal(
    <div
      data-ribbon-dropdown
      className="fixed z-50 max-h-72 overflow-auto rounded border border-border bg-background py-1 shadow-xl"
      style={{ left: position.left, top: position.top, width: position.width }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function RibbonButton({
  item,
  style,
  run,
  compact,
  showLabel,
}: {
  item: RibbonCommand;
  style: RibbonStyle | null;
  run: RunCommand;
  compact: boolean;
  showLabel?: boolean;
}) {
  const Icon = iconOf(item.icon);
  const active = isActive(item.command, item.args, style);
  const disabled = isDisabled(item.command, style);
  return (
    <button
      type="button"
      title={item.title}
      aria-label={item.title}
      aria-pressed={item.command === "executePainter" ? active : undefined}
      disabled={disabled}
      className={`flex items-center justify-center gap-1 rounded text-xs ${
        compact ? "h-7 min-w-7 px-1" : "h-8 min-w-8 px-1.5"
      } ${
        disabled
          ? "text-foreground-subtlest opacity-40"
          : active
            ? "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-500/40"
            : "text-foreground hover:bg-surface"
      }`}
      onClick={() => {
        if (item.prompt) {
          const answer = window.prompt(item.prompt.message, "");
          if (answer === null) return;
          const args = [...(item.args ?? [])];
          args[item.prompt.at] = answer;
          run(item.command, args);
          return;
        }
        run(item.command, item.args);
      }}
    >
      {Icon ? <Icon className={compact ? "size-4" : "size-5"} /> : null}
      {!Icon || showLabel ? <span className="px-1">{item.label}</span> : null}
    </button>
  );
}

export function RibbonSelectView({
  item,
  style,
  run,
  compact,
}: {
  item: RibbonSelect;
  style: RibbonStyle | null;
  run: RunCommand;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const Icon = iconOf(item.icon);
  const value = item.current?.(style ?? {}) ?? null;
  const valueLabel = item.options.find((option) => String(option.args[0]) === value)?.label ?? value;
  const swatch = item.swatch?.(style ?? {}) ?? null;
  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        title={item.title}
        className={`flex items-center gap-1 rounded border border-border text-xs text-foreground hover:bg-surface ${
          compact ? "h-7 max-w-24 px-1.5" : "h-8 px-1.5"
        }`}
        onClick={() => setOpen((current) => !current)}
      >
        {Icon ? <Icon className={compact ? "size-4" : "size-5"} /> : null}
        {!compact ? <span className="max-w-16 shrink-0 text-foreground-subtle">{item.label}</span> : null}
        <span className="truncate">{valueLabel ?? item.title}</span>
        <span className="text-foreground-subtle">▾</span>
      </button>
      {swatch ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0.5 left-1.5 right-5 h-1 rounded-sm"
          style={{ backgroundColor: swatch }}
        />
      ) : null}
      <DropdownPanel open={open} anchorRef={anchorRef} onClose={() => setOpen(false)}>
        {item.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-surface ${
              String(option.args[0]) === value ? "text-sky-300" : ""
            }`}
            onClick={() => {
              setOpen(false);
              run(optionsCommand(item.title), option.args);
            }}
          >
            {String(option.args[0] ?? "").startsWith("rgb") ? (
              <span
                className="size-3 shrink-0 rounded-sm border border-border"
                style={{ backgroundColor: String(option.args[0]) }}
              />
            ) : null}
            <span className="truncate">{option.label}</span>
          </button>
        ))}
      </DropdownPanel>
    </div>
  );
}

export function StyleGalleryView({
  gallery,
  style,
  run,
}: {
  gallery: RibbonGallery;
  style: RibbonStyle | null;
  run: RunCommand;
}) {
  const current = gallery.current?.(style ?? {}) ?? null;
  return (
    <div className="flex items-center gap-1">
      {gallery.items.map((item) => (
        <button
          key={item.label}
          type="button"
          title={`应用样式：${item.label}`}
          className={`flex h-14 flex-col items-start justify-center gap-0.5 rounded border px-2 text-left ${
            current === item.label ? "border-sky-500 bg-sky-500/10 text-sky-200" : "border-border hover:bg-surface"
          }`}
          style={{ minWidth: 64 }}
          onClick={() => run("executeTitle", item.args)}
        >
          <span className="truncate text-foreground" style={item.style}>
            {item.label}
          </span>
          <span className="text-[9px] text-foreground-subtlest">{item.label === "正文" ? "Normal" : "Heading"}</span>
        </button>
      ))}
    </div>
  );
}
