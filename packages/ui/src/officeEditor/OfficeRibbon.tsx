/**
 * 功能区（Ribbon）渲染：信息架构与命令来自 canvas-editor 官方 demo（见 officeRibbonModel.ts 顶部注释），
 * 这里只负责把它渲染成 React 界面：分组标题、选中态高亮、下拉面板、表格上下文标签。
 */
import { useEffect, useRef, useState } from "react";
import {
  RIBBON_TABS,
  type RibbonCommand,
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

function isActive(item: RibbonCommand, style: RibbonStyle | null): boolean {
  if (!style) return false;
  switch (item.command) {
    case "executeBold":
      return style.bold === true;
    case "executeItalic":
      return style.italic === true;
    case "executeUnderline":
      return style.underline === true;
    case "executeStrikeout":
      return style.strikeout === true;
    case "executePainter":
      return style.painter === true;
    case "executeUndo":
      return style.undo === true;
    case "executeRedo":
      return style.redo === true;
    case "executeRowFlex":
      return style.rowFlex === item.args?.[0];
    case "executeList":
    case "executeInsertElementList":
      return false;
    default:
      return false;
  }
}

function currentValue(item: RibbonSelect, style: RibbonStyle | null): string | null {
  if (!style) return null;
  const value = item.current?.(style) ?? null;
  return value;
}

function RibbonButton({
  item,
  style,
  run,
}: {
  item: RibbonCommand;
  style: RibbonStyle | null;
  run: OfficeRibbonProps["run"];
}) {
  const active = isActive(item, style);
  return (
    <button
      type="button"
      title={item.title}
      aria-label={item.title}
      aria-pressed={active}
      className={`min-w-7 rounded border px-1.5 py-1 text-xs leading-none ${
        active ? "border-accent bg-accent/10 text-accent" : "border-transparent hover:border-border hover:bg-surface"
      }`}
      onClick={() => {
        if (item.prompt) {
          const answer = window.prompt(item.prompt.message, "");
          if (answer === null) return;
          const args = [...(item.args ?? [])];
          args[item.prompt.at] = answer;
          run(item.command, args.length ? args : undefined);
          return;
        }
        run(item.command, item.args);
      }}
    >
      {item.label}
    </button>
  );
}

function RibbonSelect({ item, style, run }: { item: RibbonSelect; style: RibbonStyle | null; run: OfficeRibbonProps["run"] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);
  const value = currentValue(item, style);
  const valueLabel =
    item.options.find((option) => String(option.args[0]) === value)?.label ?? value ?? "—";
  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        title={item.title}
        className="flex min-w-14 items-center gap-1 rounded border border-border px-1.5 py-1 text-xs leading-none hover:bg-surface"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-foreground-subtle">{item.label}</span>
        <span className="max-w-24 truncate">{valueLabel}</span>
        <span className="text-foreground-subtle">▾</span>
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-48 overflow-auto rounded border border-border bg-background py-1 shadow-lg">
          {item.options.map((option) => (
            <button
              key={option.label}
              type="button"
              className={`block w-full truncate px-2 py-1 text-left text-xs hover:bg-surface ${
                String(option.args[0]) === value ? "text-accent" : ""
              }`}
              onClick={() => {
                setOpen(false);
                run(optionCommand(item), option.args);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 下拉项对应哪条命令：按分组内的下拉语义映射（与 officeRibbonModel 的选项一一对应）。 */
function optionCommand(item: RibbonSelect): string {
  switch (item.title) {
    case "字体":
      return "executeFont";
    case "字号":
      return "executeSize";
    case "行距":
      return "executeRowMargin";
    case "标题级别":
      return "executeTitle";
    case "项目符号与编号":
      return "executeList";
    case "文字颜色":
      return "executeColor";
    case "高亮（底纹）":
      return "executeHighlight";
    case "插入内容控件":
      return "executeInsertControlByType";
    case "纸张大小":
      return "executePaperSize";
    case "纸张方向":
      return "executePaperDirection";
    case "页边距":
      return "executeSetPaperMargin";
    case "分栏":
      return "executeSetColumns";
    case "单元格底色":
      return "executeSetTableCellBackgroundColor";
    case "单元格垂直对齐":
      return "executeSetTableCellVerticalAlign";
    default:
      return "executeNoop";
  }
}

function Group({ group, style, run }: { group: RibbonGroup; style: RibbonStyle | null; run: OfficeRibbonProps["run"] }) {
  return (
    <div className="flex items-stretch gap-1 border-r border-border px-2 last:border-r-0">
      <div className="flex flex-wrap items-center gap-0.5">{group.items.map((item) => renderItem(item, style, run))}</div>
      <div className="flex items-end pb-0.5 pl-1 text-[10px] text-foreground-subtlest">{group.label}</div>
    </div>
  );
}

function renderItem(item: RibbonItem, style: RibbonStyle | null, run: OfficeRibbonProps["run"]) {
  return item.kind === "command" ? (
    <RibbonButton key={item.title} item={item} style={style} run={run} />
  ) : (
    <RibbonSelect key={item.title} item={item} style={style} run={run} />
  );
}

export function OfficeRibbon({ style, inTable, run }: OfficeRibbonProps) {
  const [activeTabId, setActiveTabId] = useState("home");
  const tabs = RIBBON_TABS.filter((tab) => !tab.contextual || inTable);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  return (
    <div className="border-b border-border bg-background">
      <div className="flex items-center gap-0.5 border-b border-border px-2 pt-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`rounded-t px-2.5 py-1 text-xs ${
              tab.id === activeTab?.id ? "border border-b-0 border-border bg-surface text-accent" : "text-foreground-subtle hover:text-foreground"
            }`}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        {inTable ? <span className="ml-2 text-[10px] text-foreground-subtlest">已进入表格</span> : null}
      </div>
      <div className="flex flex-wrap items-start gap-0 py-1.5">
        {activeTab?.groups.map((group) => (
          <Group key={group.label} group={group} style={style} run={run} />
        ))}
      </div>
    </div>
  );
}
