/**
 * 功能区外壳：选项卡 + 分组 + **三级自适应布局**（2026-10-15，为用户反馈"侧栏窄时不适配"补）。
 *
 * 为什么需要自适应：侧栏宽度可拖（实测窄约 650px、宽 1000px+）。单行 + 横向滚动在窄侧栏里一次只能
 * 看到两个分组，实际不可用；一直换行在宽侧栏里又浪费高度。Word/WPS 的做法是分级降级：
 *   - wide   (≥1040px)：完整标签，一行铺开；
 *   - medium (≥660px) ：下拉收成「图标 + 当前值」（去掉标签文字），按钮略缩；
 *   - narrow (<660px)  ：分组**换行**（分组名齐底），次要命令（priority=secondary）汇总进「⋯」溢出菜单。
 * 数据与命令出处见 officeRibbonModel.ts 顶部注释。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { RibbonButton, RibbonSelectView, StyleGalleryView, type RunCommand } from "./RibbonItemViews.js";
import { RIBBON_TABS, type RibbonGroup, type RibbonItem, type RibbonStyle } from "./officeRibbonModel.js";

export interface OfficeRibbonProps {
  style: RibbonStyle | null;
  inTable: boolean;
  run: RunCommand;
}

type RibbonLayout = "wide" | "medium" | "narrow";

const WIDE_MIN_WIDTH = 1040;
const MEDIUM_MIN_WIDTH = 660;

function layoutFor(width: number): RibbonLayout {
  if (width >= WIDE_MIN_WIDTH) return "wide";
  if (width >= MEDIUM_MIN_WIDTH) return "medium";
  return "narrow";
}

function renderItem(item: RibbonItem, style: RibbonStyle | null, run: RunCommand, compact: boolean) {
  if (item.kind === "command") {
    return <RibbonButton key={item.title} item={item} style={style} run={run} compact={compact} />;
  }
  if (item.kind === "select") {
    return <RibbonSelectView key={item.title} item={item} style={style} run={run} compact={compact} />;
  }
  return <StyleGalleryView key={item.title} gallery={item} style={style} run={run} />;
}

/** 溢出菜单：窄布局下装次要命令（Word/WPS 的「⋯」）。 */
function OverflowMenu({
  items,
  style,
  run,
  label,
}: {
  items: RibbonItem[];
  style: RibbonStyle | null;
  run: RunCommand;
  label: string;
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
  if (items.length === 0) return null;
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        title={`更多（${label}）`}
        aria-label={`更多（${label}）`}
        className="flex h-7 min-w-7 items-center justify-center rounded px-1 text-foreground hover:bg-surface"
        onClick={() => setOpen((current) => !current)}
      >
        ⋯
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded border border-border bg-background py-1 shadow-lg">
          <div className="px-2 py-1 text-[11px] text-foreground-subtle">{label} · 更多</div>
          {items.map((item) => (
            <div key={item.title} className="flex items-center gap-1 px-2 py-1">
              {item.kind === "select" ? <RibbonSelectView item={item} style={style} run={run} compact={false} /> : null}
              {item.kind === "command" ? (
                <>
                  <RibbonButton item={item} style={style} run={run} compact />
                  <span className="truncate text-xs text-foreground-subtle">{item.title}</span>
                </>
              ) : null}
              {item.kind === "gallery" ? <StyleGalleryView gallery={item} style={style} run={run} /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Group({
  group,
  style,
  run,
  compact,
  wrap,
  overflow,
}: {
  group: RibbonGroup;
  style: RibbonStyle | null;
  run: RunCommand;
  compact: boolean;
  wrap: boolean;
  overflow?: RibbonItem[];
}) {
  const primary = wrap ? group.items.filter((item) => item.priority !== "secondary") : group.items;
  return (
    <div
      className={`flex shrink-0 flex-col justify-between border-r border-border px-2 py-1 last:border-r-0 ${
        wrap ? "min-h-[72px]" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-0.5">
        {primary.map((item) => renderItem(item, style, run, compact))}
        {overflow && overflow.length > 0 ? (
          <OverflowMenu items={overflow} style={style} run={run} label={group.label} />
        ) : null}
      </div>
      <div className="pt-1 text-center text-[11px] text-foreground-subtle">{group.label}</div>
    </div>
  );
}

export function OfficeRibbon({ style, inTable, run }: OfficeRibbonProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [activeTabId, setActiveTabId] = useState("home");

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const layout = layoutFor(width || WIDE_MIN_WIDTH);
  const compact = layout !== "wide";
  const wrap = layout === "narrow";
  const tabs = RIBBON_TABS.filter((tab) => !tab.contextual || inTable);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  /** 窄布局把所有分组的次要命令汇总成一个「⋯」（避免每个分组各挂一个）。 */
  const overflowItems = useMemo(
    () =>
      wrap
        ? (activeTab?.groups.flatMap((group) => group.items.filter((item) => item.priority === "secondary")) ?? [])
        : [],
    [activeTab, wrap],
  );

  return (
    // mousedown 阻止默认：点功能区不能让画布失焦——否则选区丢失、撤销/格式化不生效（真机反馈）。
    <div className="border-b border-border bg-background" onMouseDown={(event) => event.preventDefault()} ref={rootRef}>
      <div className="flex items-end gap-1 border-b border-border px-2 pt-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${
              tab.id === activeTab?.id
                ? "border-sky-400 font-medium text-sky-300"
                : "border-transparent text-foreground hover:bg-surface"
            }`}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        {inTable ? <span className="ml-2 pb-2 text-[11px] text-foreground-subtle">光标在表格内</span> : null}
        <span className="ml-auto pb-2 text-[10px] text-foreground-subtlest">
          {layout === "wide" ? "完整" : layout === "medium" ? "紧凑" : "窄栏"}
        </span>
      </div>
      <div className={`flex items-stretch ${wrap ? "flex-wrap" : "overflow-x-auto"}`}>
        {activeTab?.groups.map((group) => (
          <Group key={group.label} group={group} style={style} run={run} compact={compact} wrap={wrap} />
        ))}
        {wrap && overflowItems.length > 0 ? (
          <Group group={{ label: "更多", items: [] }} style={style} run={run} compact wrap={false} overflow={overflowItems} />
        ) : null}
      </div>
    </div>
  );
}
