/**
 * 功能区渲染（对标 Word/WPS 版式）：选项卡 + 分组框（底部分组名）+ 图标按钮 + 分体颜色按钮 + 样式库。
 *
 * 只做渲染与交互；命令、参数形态与功能面来自 officeRibbonModel.ts（出处见该文件顶部注释）。
 * 图标是微软自家的 @fluentui/react-icons（MIT），**逐个具名导入**以便 tree-shaking
 * （整包 26,720 个图标，不能 `import *`）。
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
  DocumentOnePage24Regular,
  DocumentPageBottomCenter24Regular,
  DocumentPageBreak24Regular,
  DocumentFit24Regular,
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
import { useEffect, useRef, useState } from "react";
import {
  RIBBON_TABS,
  type RibbonGallery,
  type RibbonGroup,
  type RibbonItem,
  type RibbonSelect,
  type RibbonStyle,
} from "./officeRibbonModel.js";

export interface OfficeRibbonProps {
  style: RibbonStyle | null;
  inTable: boolean;
  run: (command: string, args?: unknown[]) => void;
}

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

const ICON_CLASS = "size-5";

function isActive(command: string, args: unknown[] | undefined, style: RibbonStyle | null): boolean {
  if (!style) return false;
  if (command === "executeRowFlex") return style.rowFlex === args?.[0];
  if (command === "executeList") return style.listType === args?.[0];
  const map: Record<string, boolean | undefined> = {
    executeBold: style.bold,
    executeItalic: style.italic,
    executeUnderline: style.underline,
    executeStrikeout: style.strikeout,
    // 格式刷是"模式开关"；撤销/重做**不是**（可用/不可用只体现在置灰，不能画成按下态——真机截图反馈）
    executePainter: style.painter,
  };
  return map[command] === true;
}

/** 撤销/重做/（未来的只读开关）这类"可用性由引擎给出"的按钮：不可用就置灰。 */
function isDisabled(command: string, style: RibbonStyle | null): boolean {
  if (!style) return false;
  if (command === "executeUndo") return style.undo === false;
  if (command === "executeRedo") return style.redo === false;
  return false;
}

function optionsCommand(title: string): string {
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
      return "executeHighlight";
    case "单元格底色":
      return "executeSetTableCellBackgroundColor";
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

function IconButton({
  item,
  style,
  run,
}: {
  item: Extract<RibbonItem, { kind: "command" }>;
  style: RibbonStyle | null;
  run: OfficeRibbonProps["run"];
}) {
  const Icon = item.icon ? ICONS[item.icon] : undefined;
  const active = isActive(item.command, item.args, style);
  const disabled = isDisabled(item.command, style);
  return (
    <button
      type="button"
      title={item.title}
      aria-label={item.title}
      aria-pressed={item.command === "executePainter" ? active : undefined}
      disabled={disabled}
      className={`flex h-8 min-w-8 items-center justify-center gap-1 rounded px-1.5 text-xs ${
        disabled
          ? "text-foreground-subtlest opacity-40"
          : active
            ? "bg-accent/15 text-accent ring-1 ring-inset ring-accent/40"
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
      {Icon ? <Icon className={ICON_CLASS} /> : <span className="px-1">{item.label}</span>}
    </button>
  );
}

function SelectControl({
  item,
  style,
  run,
}: {
  item: RibbonSelect;
  style: RibbonStyle | null;
  run: OfficeRibbonProps["run"];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const Icon = item.icon ? ICONS[item.icon] : undefined;
  const value = item.current?.(style ?? {}) ?? null;
  const valueLabel = item.options.find((option) => String(option.args[0]) === value)?.label ?? value;
  const swatch = item.swatch?.(style ?? {}) ?? null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title={item.title}
        className="flex h-8 items-center gap-1 rounded border border-border px-1.5 text-xs text-foreground hover:bg-surface"
        onClick={() => setOpen((value) => !value)}
      >
        {Icon ? <Icon className={ICON_CLASS} /> : null}
        <span className="max-w-20 truncate">{valueLabel ?? item.label}</span>
        <span className="text-foreground-subtle">▾</span>
      </button>
      {swatch ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0.5 left-1.5 right-5 h-1 rounded-sm"
          style={{ backgroundColor: swatch }}
        />
      ) : null}
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-52 overflow-auto rounded border border-border bg-background py-1 shadow-lg">
          {item.options.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-surface ${
                String(option.args[0]) === value ? "text-accent" : ""
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
        </div>
      ) : null}
    </div>
  );
}

function StyleGallery({
  gallery,
  style,
  run,
}: {
  gallery: RibbonGallery;
  style: RibbonStyle | null;
  run: OfficeRibbonProps["run"];
}) {
  const current = gallery.current?.(style ?? {}) ?? null;
  return (
    <div className="flex items-center gap-1">
      {gallery.items.map((item) => (
        <button
          key={item.label}
          type="button"
          title={`应用样式：${item.label}`}
          className={`flex h-14 w-[76px] flex-col items-start justify-center gap-0.5 rounded border px-2 text-left ${
            current === item.label || (item.label === "正文" && current === "正文")
              ? "border-accent bg-accent/10"
              : "border-border hover:bg-surface"
          }`}
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

function Group({ group, style, run }: { group: RibbonGroup; style: RibbonStyle | null; run: OfficeRibbonProps["run"] }) {
  return (
    <div className="flex flex-col justify-between border-r border-border px-2 py-1 last:border-r-0">
      <div className="flex flex-wrap items-center gap-0.5">
        {group.items.map((item) =>
          item.kind === "command" ? (
            <IconButton key={item.title} item={item} style={style} run={run} />
          ) : item.kind === "select" ? (
            <SelectControl key={item.title} item={item} style={style} run={run} />
          ) : (
            <StyleGallery key={item.title} gallery={item} style={style} run={run} />
          ),
        )}
      </div>
      <div className="pt-0.5 text-center text-[10px] text-foreground-subtlest">{group.label}</div>
    </div>
  );
}

export function OfficeRibbon({ style, inTable, run }: OfficeRibbonProps) {
  const [activeTabId, setActiveTabId] = useState("home");
  const tabs = RIBBON_TABS.filter((tab) => !tab.contextual || inTable);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  return (
    // mousedown 阻止默认：点功能区不能让画布失焦——否则选区丢失、撤销/格式化不生效（真机反馈：
    // "撤销不能用，但 Ctrl+Z 可以"）。键盘快捷键保持焦点所以一直可用，这里对齐两者。
    <div className="border-b border-border bg-background" onMouseDown={(event) => event.preventDefault()}>
      <div className="flex items-end gap-0.5 border-b border-border px-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`rounded-t px-3 py-1 text-xs ${
              tab.id === activeTab?.id
                ? "border border-b-0 border-border bg-surface font-medium text-accent"
                : "text-foreground-subtle hover:text-foreground"
            }`}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        {inTable ? <span className="ml-2 pb-1 text-[10px] text-foreground-subtlest">光标在表格内</span> : null}
      </div>
      {/* 单行排布 + 横向滚动（WPS/Word 的功能区不会换行；换行会让分组名高度参差） */}
      <div className="flex items-stretch overflow-x-auto">
        {activeTab?.groups.map((group) => (
          <Group key={group.label} group={group} style={style} run={run} />
        ))}
      </div>
    </div>
  );
}
