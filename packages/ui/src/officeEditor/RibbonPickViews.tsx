/**
 * 两个"不是简单按钮"的功能区视图件：表格插入器与查找替换器。
 *
 * 为什么要单独做：真机反馈里"表格左边点击展开之后不应该固定插入一个尺寸"（要网格拖动 + 自定义），
 * 以及"查找替换不能用"（引擎的 `executeReplace` 实测无效、`executeSearch` 只高亮不移动选区）。
 * 这两块的交互与状态都比普通按钮重，所以从 RibbonItemViews 拆出来，守住单文件 400 行上限。
 */
import { Search24Regular, TableSimple24Regular } from "@fluentui/react-icons";
import { useRef, useState } from "react";
import { DropdownPanel, useRibbonDropdown } from "./RibbonDropdown.js";
import type { RibbonFind, RibbonTable, RunCommand } from "./officeRibbonModel.js";

const TABLE_GRID_COLS = 10;
const TABLE_GRID_ROWS = 8;

/** 表格插入器：网格拖动选行列（Word/WPS 同款），下面还能直接填数字。 */
export function RibbonTablePickView({ item, run }: { item: RibbonTable; run: RunCommand }) {
  const dropdown = useRibbonDropdown();
  const dropdownId = `table:${item.title}`;
  const open = dropdown.openId === dropdownId;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState({ rows: 0, cols: 0 });
  const [custom, setCustom] = useState({ rows: 3, cols: 3 });

  const insert = (rows: number, cols: number) => {
    if (rows < 1 || cols < 1) return;
    run("executeInsertTable", [rows, cols]);
    dropdown.close();
  };

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        title={item.title}
        aria-label={item.title}
        data-office-ribbon-table
        className={`flex h-8 items-center gap-1 rounded border px-2 text-xs ${
          open ? "border-sky-500 text-sky-200" : "border-border text-foreground hover:bg-surface"
        }`}
        onClick={() => dropdown.toggle(dropdownId)}
      >
        <TableSimple24Regular className="size-5" />
        <span>{item.label}</span>
        <span className="text-foreground-subtle">▾</span>
      </button>
      <DropdownPanel open={open} anchorRef={anchorRef} onClose={dropdown.close} minWidth={248}>
        <div className="px-2 py-1 text-xs text-foreground-subtle">
          {hover.rows > 0 ? `${hover.cols} × ${hover.rows} 表格` : "拖动选择行列"}
        </div>
        <div
          className="px-2 pb-2"
          data-office-ribbon-table-grid
          onMouseLeave={() => setHover({ rows: 0, cols: 0 })}
        >
          {Array.from({ length: TABLE_GRID_ROWS }, (_, rowIndex) => (
            <div key={rowIndex} className="flex">
              {Array.from({ length: TABLE_GRID_COLS }, (_, colIndex) => {
                const active = colIndex < hover.cols && rowIndex < hover.rows;
                return (
                  <button
                    key={colIndex}
                    type="button"
                    aria-label={`${colIndex + 1} 列 ${rowIndex + 1} 行`}
                    data-office-ribbon-table-cell
                    className={`size-4 border ${
                      active
                        ? "border-sky-400 bg-sky-500/30"
                        : "border-border hover:border-sky-400 hover:bg-sky-500/15"
                    }`}
                    onMouseEnter={() => setHover({ rows: rowIndex + 1, cols: colIndex + 1 })}
                    onClick={() => insert(rowIndex + 1, colIndex + 1)}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 border-t border-border px-2 py-2 text-xs">
          <span className="text-foreground-subtle">自定义</span>
          <input
            type="number"
            min={1}
            max={50}
            value={custom.rows}
            aria-label="行数"
            className="w-12 rounded border border-border bg-transparent px-1 py-0.5 text-center"
            onChange={(event) =>
              setCustom((current) => ({ ...current, rows: Number(event.target.value) || 1 }))
            }
          />
          <span className="text-foreground-subtle">行</span>
          <input
            type="number"
            min={1}
            max={30}
            value={custom.cols}
            aria-label="列数"
            className="w-12 rounded border border-border bg-transparent px-1 py-0.5 text-center"
            onChange={(event) =>
              setCustom((current) => ({ ...current, cols: Number(event.target.value) || 1 }))
            }
          />
          <span className="text-foreground-subtle">列</span>
          <button
            type="button"
            className="ml-auto rounded border border-border px-2 py-0.5 hover:border-sky-500 hover:text-sky-200"
            onClick={() => insert(custom.rows, custom.cols)}
          >
            插入
          </button>
        </div>
      </DropdownPanel>
    </div>
  );
}

/** 查找替换器：引擎给"关键词高亮/命中数"，替换与选区推进由这里的命令驱动。 */
export function RibbonFindView({ item, run }: { item: RibbonFind; run: RunCommand }) {
  const dropdown = useRibbonDropdown();
  const dropdownId = `find:${item.title}`;
  const open = dropdown.openId === dropdownId;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [keyword, setKeyword] = useState("");
  const [replacement, setReplacement] = useState("");
  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        title={item.title}
        aria-label={item.title}
        data-office-ribbon-find
        className={`flex h-8 items-center gap-1 rounded px-1.5 text-xs ${
          open ? "bg-sky-500/15 text-sky-300" : "text-foreground hover:bg-surface"
        }`}
        onClick={() => dropdown.toggle(dropdownId)}
      >
        <Search24Regular className="size-5" />
        <span className="text-foreground-subtle">▾</span>
      </button>
      <DropdownPanel open={open} anchorRef={anchorRef} onClose={dropdown.close} minWidth={268}>
        <div className="px-2 py-1 text-[11px] text-foreground-subtle">查找替换</div>
        <div className="flex items-center gap-1 px-2 pb-1">
          <input
            value={keyword}
            aria-label="查找内容"
            placeholder="查找内容"
            className="w-32 rounded border border-border bg-transparent px-1.5 py-1 text-xs"
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") run("executeFind", [keyword]);
            }}
          />
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs hover:border-sky-500"
            onClick={() => run("executeFind", [keyword])}
          >
            查找
          </button>
          <button
            type="button"
            title="上一个"
            aria-label="上一个"
            className="rounded border border-border px-1.5 py-1 text-xs hover:border-sky-500"
            onClick={() => run("executeFindPrev", [keyword])}
          >
            ↑
          </button>
          <button
            type="button"
            title="下一个"
            aria-label="下一个"
            className="rounded border border-border px-1.5 py-1 text-xs hover:border-sky-500"
            onClick={() => run("executeFindNext", [keyword])}
          >
            ↓
          </button>
        </div>
        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            value={replacement}
            aria-label="替换为"
            placeholder="替换为"
            className="w-32 rounded border border-border bg-transparent px-1.5 py-1 text-xs"
            onChange={(event) => setReplacement(event.target.value)}
          />
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs hover:border-sky-500"
            onClick={() => run("executeReplaceOne", [keyword, replacement])}
          >
            替换
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs hover:border-sky-500"
            onClick={() => run("executeReplaceAll", [keyword, replacement])}
          >
            全部替换
          </button>
        </div>
        <div className="border-t border-border px-2 py-1 text-[10px] text-foreground-subtle">
          替换留空就是删除；结果与"第 n / 共 m"在编辑区上方状态栏
        </div>
      </DropdownPanel>
    </div>
  );
}
