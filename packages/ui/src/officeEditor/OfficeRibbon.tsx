/**
 * 功能区外壳：选项卡 + 分组 + **按宽度放得下多少放多少**（2026-10-15，为用户反馈"侧栏窄时不适配"补）。
 *
 * 为什么不用"宽度门槛 + 换行"那套：先量后定做出来才发现，开始标签完整铺开要 1656px、紧凑铺开也要 1379px，
 * 而侧栏实际只有 650~1000px——任何固定门槛都救不了，换成换行又会把功能区撑成两三层，
 * 而且"开始"因为样式库最高，切标签时比别的标签高一截。所以照 **Word/WPS 的真实做法**：
 *   - 分组一行铺开，装不下的分组收进末尾的「»」菜单（点开还是完整的一组命令）；
 *   - 单个分组自己都放不下时，这一组收成「分组名 ▾」按钮；
 *   - 取舍顺序由数据决定：先收非必要分组（从左到右），再收必要分组（从右到左），
 *     这样最窄时留下的恰好是最常用的字体/段落。
 * 宽度是**量出来的**（布局阶段量真实 DOM，不猜），所以不存在"内容比容器宽"的横向滚动条。
 * 高度用统一下限兜住（开始标签的样式库卡片最高），切标签不会跳。
 *
 * 数据在 officeRibbonTabs.ts，命令出处见 officeRibbonModel.ts 顶部注释。
 * 布局回归检查：scripts/check-office-ribbon-layout.mjs。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DropdownPanel, RibbonDropdownProvider, useRibbonDropdown } from "./RibbonDropdown.js";
import { RibbonFindView, RibbonPromptButton, RibbonTablePickView } from "./RibbonPickViews.js";
import {
  RibbonButton,
  RibbonItemRows,
  RibbonMenuView,
  RibbonSelectView,
  StyleGalleryView,
} from "./RibbonItemViews.js";
import { RIBBON_TABS } from "./officeRibbonTabs.js";
import type {
  RibbonGroup,
  RibbonItem,
  RibbonStyle,
  RibbonTab,
  RunCommand,
} from "./officeRibbonModel.js";

export interface OfficeRibbonProps {
  style: RibbonStyle | null;
  /** 光标在表格内：只影响 Word 那套的「表格工具」标签是否出现。 */
  inTable?: boolean;
  run: RunCommand;
  /** 标签数据：默认 Word 那套；Excel 编辑位传自己的（外壳的宽度取舍对两边都适用）。 */
  tabs?: RibbonTab[];
  /** 右上角的一句话（例如"光标在表格内"/"只读"）。 */
  hint?: string;
}

/**
 * 分组行的下限高度：开始标签的样式库卡片最高（实测 85px），下限必须盖过它，否则切标签会跳 1px～几像素。
 */
const GROUPS_MIN_HEIGHT = 88;
/** 收成按钮的分组宽度：按钮撑开后的实测值，用于"这一组是否只能收成按钮"的判断。 */
const COLLAPSED_GROUP_WIDTH = 76;
/** 末尾「»」按钮的宽度。 */
const MORE_BUTTON_WIDTH = 40;

type GroupState = "expanded" | "collapsed" | "hidden";

/**
 * 摆放顺序（不等于显示顺序）：必要分组优先，其余按原顺序。
 * 「必要」在数据里标（字体/段落/表格…），因为它们在编辑时最常用。
 */
function placementOrder(groups: RibbonGroup[]): RibbonGroup[] {
  return [
    ...groups.filter((group) => group.essential),
    ...groups.filter((group) => !group.essential),
  ];
}

function renderItem(item: RibbonItem, style: RibbonStyle | null, run: RunCommand) {
  if (item.kind === "command" && item.prompt)
    return <RibbonPromptButton key={item.title} item={item} run={run} />;
  if (item.kind === "command")
    return <RibbonButton key={item.title} item={item} style={style} run={run} />;
  if (item.kind === "select")
    return <RibbonSelectView key={item.title} item={item} style={style} run={run} />;
  if (item.kind === "menu")
    return <RibbonMenuView key={item.title} item={item} style={style} run={run} />;
  if (item.kind === "table") return <RibbonTablePickView key={item.title} item={item} run={run} />;
  if (item.kind === "find") return <RibbonFindView key={item.title} item={item} run={run} />;
  return <StyleGalleryView key={item.title} gallery={item} style={style} run={run} />;
}

/** 末尾的「»」：装不下的分组都在这儿，每段还是完整的一组（Word/WPS 的同一招）。 */
function MoreGroupsMenu({
  groups,
  style,
  run,
}: {
  groups: RibbonGroup[];
  style: RibbonStyle | null;
  run: RunCommand;
}) {
  const dropdown = useRibbonDropdown();
  const dropdownId = "groups:more";
  const open = dropdown.openId === dropdownId;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  if (groups.length === 0) return null;
  return (
    <div className="relative flex shrink-0 items-center px-1" ref={anchorRef}>
      <button
        type="button"
        title="更多分组"
        aria-label="更多分组"
        data-office-ribbon-more
        className={`flex h-8 w-8 items-center justify-center rounded border text-sm ${
          open ? "border-sky-500 text-sky-200" : "border-border text-foreground hover:bg-surface"
        }`}
        onClick={() => dropdown.toggle(dropdownId)}
      >
        »
      </button>
      <DropdownPanel open={open} anchorRef={anchorRef} onClose={dropdown.close} minWidth={288}>
        {groups.map((group) => (
          <div key={group.label} className="border-b border-border/60 py-1 last:border-b-0">
            <div className="px-2 py-1 text-[11px] text-foreground-subtle">{group.label}</div>
            <RibbonItemRows items={group.items} style={style} run={run} />
          </div>
        ))}
      </DropdownPanel>
    </div>
  );
}

/** 收成按钮的分组：点开是整组命令（Word/WPS 的"— 分组名 ▾"）。 */
function CollapsedGroup({
  group,
  style,
  run,
}: {
  group: RibbonGroup;
  style: RibbonStyle | null;
  run: RunCommand;
}) {
  const dropdown = useRibbonDropdown();
  const dropdownId = `group:${group.label}`;
  const open = dropdown.openId === dropdownId;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      className="relative flex shrink-0 flex-col justify-between border-r border-border px-1 py-1 last:border-r-0"
      ref={anchorRef}
    >
      <button
        type="button"
        title={`${group.label}（此宽度下整组收进这里）`}
        data-office-ribbon-collapsed={group.label}
        className={`flex h-8 items-center gap-1 rounded border px-2 text-xs ${
          open ? "border-sky-500 text-sky-200" : "border-border text-foreground hover:bg-surface"
        }`}
        onClick={() => dropdown.toggle(dropdownId)}
      >
        <span>{group.label}</span>
        <span className="text-foreground-subtle">▾</span>
      </button>
      <DropdownPanel open={open} anchorRef={anchorRef} onClose={dropdown.close} minWidth={288}>
        <div className="px-2 py-1 text-[11px] text-foreground-subtle">{group.label}</div>
        <RibbonItemRows items={group.items} style={style} run={run} />
      </DropdownPanel>
    </div>
  );
}

function Group({
  group,
  style,
  run,
  widthRef,
}: {
  group: RibbonGroup;
  style: RibbonStyle | null;
  run: RunCommand;
  widthRef: (node: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={widthRef}
      data-office-ribbon-group={group.label}
      className="flex shrink-0 flex-col justify-between border-r border-border px-2 py-1 last:border-r-0"
    >
      <div className="flex items-center gap-0.5">
        {group.items.map((item) => renderItem(item, style, run))}
      </div>
      <div className="pt-1 text-center text-[11px] text-foreground-subtle">{group.label}</div>
    </div>
  );
}

/**
 * 布局决策：按实测宽度决定哪些分组铺开、哪些收成「分组名 ▾」按钮、哪些进末尾的「»」。
 *
 * 贪心摆放（顺序＝placementOrder）：每一组先试铺开，铺不开就试收成按钮（按钮仍看得见、点得到），
 * 连按钮都放不下才丢进「»」。所以宽度不够时看到的是"最不常用的组收成了按钮"，
 * 而不是"整块命令凭空消失"——这是 Word/WPS 的行为。
 */
function planGroups(
  groups: RibbonGroup[],
  widths: Map<string, number>,
  available: number,
): Map<string, GroupState> {
  const states = new Map<string, GroupState>(groups.map((group) => [group.label, "hidden"]));
  let used = 0;
  for (const group of placementOrder(groups)) {
    const width = widths.get(group.label) ?? 120;
    if (used + width <= available) {
      states.set(group.label, "expanded");
      used += width;
      continue;
    }
    if (used + COLLAPSED_GROUP_WIDTH <= available) {
      states.set(group.label, "collapsed");
      used += COLLAPSED_GROUP_WIDTH;
    }
  }
  // 「»」本身也要占宽度：挤不下就再把一组（最不重要的那一头）埋进去
  let hiddenCount = groups.filter((group) => states.get(group.label) === "hidden").length;
  while (hiddenCount > 0 && used + MORE_BUTTON_WIDTH > available) {
    const sacrifice = placementOrder(groups)
      .reverse()
      .find((group) => states.get(group.label) !== "hidden");
    if (!sacrifice) break;
    const wasExpanded = states.get(sacrifice.label) === "expanded";
    used -= wasExpanded ? (widths.get(sacrifice.label) ?? 120) : COLLAPSED_GROUP_WIDTH;
    states.set(sacrifice.label, "hidden");
    hiddenCount += 1;
  }
  return states;
}

export function OfficeRibbon({
  style,
  inTable = false,
  run,
  tabs: customTabs,
  hint,
}: OfficeRibbonProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const groupNodes = useRef(new Map<string, HTMLDivElement>());
  const [width, setWidth] = useState(0);
  const [activeTabId, setActiveTabId] = useState("home");
  // 布局决策连同"它属于哪个 (标签, 宽度)"一起存：换代后上一代的结论必须作废，
  // 否则新标签会拿着旧结论渲染（曾经在切换标签时把结论清空，导致新标签永远不收缩）。
  const [plan, setPlan] = useState<{ key: string; states: Map<string, GroupState> } | null>(null);
  // 单一打开源：同屏只允许一个下拉（点第二个时第一个自动关）——真机反馈的互斥要求。
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const dropdownState = useMemo(
    () => ({
      openId: openDropdownId,
      toggle: (id: string) => setOpenDropdownId((current) => (current === id ? null : id)),
      close: () => setOpenDropdownId(null),
    }),
    [openDropdownId],
  );

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

  const tabs = (customTabs ?? RIBBON_TABS).filter((tab) => !tab.contextual || inTable);
  const activeTab: RibbonTab | undefined = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const groups = activeTab?.groups ?? [];

  const layoutKey = `${activeTab?.id ?? ""}:${Math.round(width)}`;
  // 没算过这一宽度就全铺开（这一帧专门用来量真实宽度），算过了才按结论渲染。
  const states = plan?.key === layoutKey ? plan.states : new Map<string, GroupState>();

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || groups.length === 0) return;
    if (plan?.key === layoutKey) return;
    const widths = new Map<string, number>();
    for (const group of groups) {
      const node = groupNodes.current.get(group.label);
      if (node) widths.set(group.label, node.getBoundingClientRect().width);
    }
    // 分组磁条宽度是内容决定的、与"别人是否隐藏"无关，所以一次测量就够，不需要反复迭代。
    setPlan({ key: layoutKey, states: planGroups(groups, widths, row.clientWidth) });
  }, [groups, layoutKey, plan]);

  const visibleGroups = groups.filter((group) => states.get(group.label) !== "hidden");
  const hiddenGroups = groups.filter((group) => states.get(group.label) === "hidden");

  return (
    // mousedown 阻止默认：点功能区不能让画布失焦——否则选区丢失、撤销/格式化不生效（真机反馈）。
    <RibbonDropdownProvider value={dropdownState}>
      <div
        data-office-ribbon-layout={hiddenGroups.length > 0 ? "fitted" : "full"}
        className="border-b border-border bg-background"
        onMouseDown={(event) => event.preventDefault()}
        ref={rootRef}
      >
        <div className="flex items-end gap-1 border-b border-border px-2 pt-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              data-office-ribbon-tab={tab.id}
              className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${
                tab.id === activeTab?.id
                  ? "border-sky-400 font-medium text-sky-300"
                  : "border-transparent text-foreground hover:bg-surface"
              }`}
              onClick={() => {
                dropdownState.close();
                setActiveTabId(tab.id);
              }}
            >
              {tab.label}
            </button>
          ))}
          {hint ? (
            <span className="ml-2 min-w-0 truncate pb-2 text-[11px] text-foreground-subtle">
              {hint}
            </span>
          ) : null}
          <span className="ml-auto pb-2 text-[10px] text-foreground-subtlest">
            {hiddenGroups.length > 0 ? `${hiddenGroups.length} 组收在 »` : "全部展开"}
          </span>
        </div>
        {/* data-office-ribbon-groups 只给回归检查与排查用（它量的是这条的高度）。 */}
        <div
          ref={rowRef}
          data-office-ribbon-groups={activeTab?.id}
          className="flex items-stretch overflow-x-auto"
          style={{ minHeight: GROUPS_MIN_HEIGHT }}
        >
          {visibleGroups.map((group) => {
            const state = states.get(group.label) ?? "expanded";
            return state === "collapsed" ? (
              <CollapsedGroup key={group.label} group={group} style={style} run={run} />
            ) : (
              <Group
                key={group.label}
                group={group}
                style={style}
                run={run}
                widthRef={(node) => {
                  if (node) groupNodes.current.set(group.label, node);
                  else groupNodes.current.delete(group.label);
                }}
              />
            );
          })}
          <MoreGroupsMenu groups={hiddenGroups} style={style} run={run} />
        </div>
      </div>
    </RibbonDropdownProvider>
  );
}
