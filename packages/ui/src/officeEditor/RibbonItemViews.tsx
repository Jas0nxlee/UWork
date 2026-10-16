/**
 * 功能区里的视图件：图标按钮 / 下拉 / 样式库，以及**面板内**的成套渲染。
 * 与 officeRibbonModel.ts 的数据一一对应；命令、参数形态的出处见该文件顶部注释。
 * 图标表与按钮态判定在 ribbonItemSupport.ts，下拉面板与互斥在 RibbonDropdown.tsx。
 *
 * 尺寸按"侧栏最窄也能用"定：按钮 32px 见方、下拉只显示当前值（不写"字体"二字，
 * Word 的字体框也是这样），装不下的分组由外壳收进「»」，视图件本身不再分级。
 *
 * 面板内不嵌面板：分组菜单里如果放一个普通下拉，点它会先关掉父面板、子面板就悬空了。
 * 所以面板内用 RibbonSelectInline——把选项平铺成一排小按钮（颜色就是色块）。
 */
import { useRef } from "react";
import { DropdownPanel, useRibbonDropdown } from "./RibbonDropdown.js";
import { iconOf, isActive, isDisabled, optionsCommand } from "./ribbonItemSupport.js";
import { RibbonFindView, RibbonPromptButton, RibbonTablePickView } from "./RibbonPickViews.js";
import type { RunCommand } from "./officeRibbonModel.js";
import type {
  RibbonCommand,
  RibbonGallery,
  RibbonItem,
  RibbonMenu,
  RibbonSelect,
  RibbonStyle,
} from "./officeRibbonModel.js";

/** 图标按钮：`prompt` 非空时先弹输入框，把答案填进指定位参数再执行。 */
export function RibbonButton({
  item,
  style,
  run,
  showLabel,
  onDone,
}: {
  item: RibbonCommand;
  style: RibbonStyle | null;
  run: RunCommand;
  showLabel?: boolean;
  /** 面板内的按钮：执行完顺手关掉面板（菜单的常规行为）。 */
  onDone?: () => void;
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
      className={`flex h-8 items-center justify-center gap-1 rounded px-1.5 text-xs ${
        item.icon ? "min-w-8" : ""
      } ${
        disabled
          ? "text-foreground-subtlest opacity-40"
          : active
            ? "bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-500/40"
            : "text-foreground hover:bg-surface"
      }`}
      onClick={() => {
        // 需要填值的命令不在这里处理：它们由 RibbonPromptButton 弹对话框
        // （Electron 没有实现 window.prompt，原本用它取值的图片/链接/公式都点了没反应）
        run(item.command, item.args);
        onDone?.();
      }}
    >
      {Icon ? <Icon className="size-5" /> : null}
      {!Icon || showLabel ? <span className="px-1">{item.label}</span> : null}
    </button>
  );
}

/** 颜色类取值（字色/底纹/单元格底色）：在选项前画色块。 */
function optionSwatch(args: unknown[]): string | null {
  const value = String(args[0] ?? "");
  return value.startsWith("rgb") || value.startsWith("#") ? value : null;
}

/** 下拉：触发器显示当前值，面板里的选项共用一条命令、以首参区分。 */
export function RibbonSelectView({
  item,
  style,
  run,
}: {
  item: RibbonSelect;
  style: RibbonStyle | null;
  run: RunCommand;
}) {
  const dropdown = useRibbonDropdown();
  const dropdownId = `select:${item.title}`;
  const open = dropdown.openId === dropdownId;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const Icon = iconOf(item.icon);
  const value = item.current?.(style ?? {}) ?? null;
  const valueLabel =
    item.options.find((option) => String(option.args[0]) === value)?.label ?? value;
  // 「是不是颜色下拉」看模型有没有 swatch 取值函数；swatch 本身是**当前颜色值**，
  // 没设过颜色时是 null——早先把 null 当成了"不是颜色下拉"，于是按钮宽度会随是否上色而跳。
  const isColorSelect = Boolean(item.swatch);
  const swatch = item.swatch?.(style ?? {}) ?? null;
  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        title={item.title}
        aria-label={item.title}
        className={`flex h-8 items-center gap-1 rounded border border-border text-xs text-foreground hover:bg-surface ${
          isColorSelect ? "max-w-20 px-1" : "max-w-32 px-1.5"
        }`}
        onClick={() => dropdown.toggle(dropdownId)}
      >
        {Icon ? <Icon className="size-5" /> : null}
        {/* 颜色类下拉只画图标 + 色条（值就是颜色本身，写"文字颜色"要占 50 多像素） */}
        {isColorSelect ? null : <span className="truncate">{valueLabel ?? item.title}</span>}
        <span className="text-foreground-subtle">▾</span>
      </button>
      {swatch ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0.5 left-1.5 right-5 h-1 rounded-sm"
          style={{ backgroundColor: swatch }}
        />
      ) : null}
      <DropdownPanel open={open} anchorRef={anchorRef} onClose={dropdown.close}>
        {item.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-neutral-500/20 ${
              String(option.args[0]) === value ? "bg-neutral-500/15 font-medium" : ""
            }`}
            onClick={() => {
              dropdown.close();
              run(optionsCommand(item.title), option.args);
            }}
          >
            {optionSwatch(option.args) ? (
              <span
                className="size-3 shrink-0 rounded-sm border border-border"
                style={{ backgroundColor: optionSwatch(option.args) ?? undefined }}
              />
            ) : null}
            <span className="truncate">{option.label}</span>
          </button>
        ))}
      </DropdownPanel>
    </div>
  );
}

/** 面板（分组菜单/溢出菜单）内的下拉：标题 + 平铺选项，点选不关面板，可以连着调几项。 */
export function RibbonSelectInline({
  item,
  style,
  run,
}: {
  item: RibbonSelect;
  style: RibbonStyle | null;
  run: RunCommand;
}) {
  const value = item.current?.(style ?? {}) ?? null;
  return (
    <div className="w-full px-2 py-1">
      <div className="pb-1 text-[11px] text-foreground-subtle">{item.title}</div>
      <div className="flex flex-wrap items-center gap-1">
        {item.options.map((option) => {
          const swatch = optionSwatch(option.args);
          const selected = String(option.args[0]) === value;
          return (
            <button
              key={option.label}
              type="button"
              title={option.label}
              className={`flex h-6 items-center gap-1 rounded border px-1.5 text-xs ${
                selected
                  ? "border-sky-500 bg-sky-500/15 text-sky-200"
                  : "border-border text-foreground hover:bg-neutral-500/20"
              }`}
              onClick={() => run(optionsCommand(item.title), option.args)}
            >
              {swatch ? (
                <span
                  className="size-3 shrink-0 rounded-sm border border-border"
                  style={{ backgroundColor: swatch }}
                />
              ) : null}
              <span className="max-w-24 truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 命令菜单：「A ▾」这种把几条相关命令收在一起的小下拉（Word 的字体组同款）。 */
export function RibbonMenuView({
  item,
  style,
  run,
}: {
  item: RibbonMenu;
  style: RibbonStyle | null;
  run: RunCommand;
}) {
  const dropdown = useRibbonDropdown();
  const dropdownId = `menu:${item.title}`;
  const open = dropdown.openId === dropdownId;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const Icon = iconOf(item.icon);
  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        title={item.title}
        className={`flex h-8 items-center gap-0.5 rounded px-1.5 text-xs ${
          open ? "bg-sky-500/15 text-sky-300" : "text-foreground hover:bg-surface"
        }`}
        onClick={() => dropdown.toggle(dropdownId)}
      >
        {Icon ? <Icon className="size-5" /> : <span>{item.label}</span>}
        <span className="text-foreground-subtle">▾</span>
      </button>
      <DropdownPanel open={open} anchorRef={anchorRef} onClose={dropdown.close} minWidth={224}>
        <RibbonItemRows items={item.items} style={style} run={run} />
      </DropdownPanel>
    </div>
  );
}

/**
 * 样式库：卡片直接显示该样式的字形效果（WPS/Word 的"样式"组同款）。
 * 单行卡片：窄侧栏里"正文/标题 1/标题 2"这一排最占地方，去掉副标题一行能省下约四成宽度。
 */
export function StyleGalleryView({
  gallery,
  style,
  run,
  onDone,
}: {
  gallery: RibbonGallery;
  style: RibbonStyle | null;
  run: RunCommand;
  onDone?: () => void;
}) {
  const current = gallery.current?.(style ?? {}) ?? null;
  return (
    <div className="flex items-center gap-1">
      {gallery.items.map((item) => (
        <button
          key={item.label}
          type="button"
          title={`应用样式：${item.label}`}
          className={`flex h-9 items-center rounded border px-2 text-left ${
            current === item.label
              ? "border-sky-500 bg-sky-500/10 text-sky-200"
              : "border-border hover:bg-surface"
          }`}
          style={{ minWidth: 48 }}
          onClick={() => {
            run("executeTitle", item.args);
            onDone?.();
          }}
        >
          <span className="truncate text-foreground" style={item.style}>
            {item.label}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * 面板内的整套条目（分组菜单、溢出菜单共用）：
 * 命令＝图标按钮 + 说明，下拉＝平铺选项，样式库＝卡片。
 */
export function RibbonItemRows({
  items,
  style,
  run,
}: {
  items: RibbonItem[];
  style: RibbonStyle | null;
  run: RunCommand;
}) {
  const dropdown = useRibbonDropdown();
  return (
    <>
      {items.map((item) => (
        <div key={item.title} className="flex items-center gap-1 px-2 py-1">
          {item.kind === "select" ? (
            <RibbonSelectInline item={item} style={style} run={run} />
          ) : null}
          {item.kind === "command" ? (
            item.prompt ? (
              <>
                <RibbonPromptButton item={item} run={run} />
                <span className="truncate text-xs text-foreground-subtle">{item.title}</span>
              </>
            ) : (
              <>
                <RibbonButton item={item} style={style} run={run} onDone={dropdown.close} />
                <span className="truncate text-xs text-foreground-subtle">{item.title}</span>
              </>
            )
          ) : null}
          {item.kind === "menu" ? (
            <div className="w-full">
              <div className="px-2 py-1 text-[11px] text-foreground-subtle">{item.title}</div>
              <RibbonItemRows items={item.items} style={style} run={run} />
            </div>
          ) : null}
          {item.kind === "table" ? <RibbonTablePickView item={item} run={run} /> : null}
          {item.kind === "find" ? <RibbonFindView item={item} run={run} /> : null}
          {item.kind === "gallery" ? (
            <StyleGalleryView gallery={item} style={style} run={run} onDone={dropdown.close} />
          ) : null}
        </div>
      ))}
    </>
  );
}
