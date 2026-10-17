/**
 * 应用内 XLSX 编辑位（fortune-sheet 引擎，MIT）。
 *
 * 为什么用 fortune-sheet：它是 Luckysheet 的官方后继，自带**公式引擎**（fork 自
 * handsontable/formula-parser）与 Excel 级交互（多选/填充柄/合并/行列增删隐藏/排序筛选/剪贴板），
 * 而 I/O 由我们自己的适配层做（xlsxWorkbook：exceljs + **差分写回**）。
 * 上游没有打包 xlsx 读写，也没有发布 readOnly 之外的裁剪版，所以工具栏/功能区都是我们自己的。
 *
 * 与产品其余部分一致：
 * - 字节来自 `IFileService.readBinaryPreview`，保存走 `writeBinaryFile`（写前比对 size/mtime、sibling 备份、原子替换）；
 * - 保存是显式的，冲突时拒绝写入；**护栏命中的工作簿只给只读**（图表/透视表/宏…会被重写丢掉）；
 * - 产物校验不过就不写盘（打不开/少表/内容掉两成就拒写）。
 *
 * 已知边界（写在界面上，不假装）：图表/透视表/切片器/条件格式/宏不写回（命中即只读）；
 * 批注、超链接、数据验证、定义名、打印设置由 exceljs 原样保留（有回归检查盯着，见
 * scripts/check-office-excel-io.mjs）。
 */
import type { Sheet } from "@fortune-sheet/core";
import { Workbook, type WorkbookInstance } from "@fortune-sheet/react";
import "@fortune-sheet/react/dist/index.css";
import type { IFileService } from "@zcode/services";
import { useCallback, useMemo, useRef, useState } from "react";
import { OfficeEditorToolbar } from "./OfficeEditorToolbar.js";
import { OfficeRibbon } from "./OfficeRibbon.js";
import { EXCEL_RIBBON_TABS } from "./excelRibbonTabs.js";
import { runExcelCommand, selectionLabel } from "./excelCommands.js";
import { useExcelDocument } from "./useExcelDocument.js";
import type { RibbonStyle } from "./officeRibbonModel.js";

export interface ExcelEditorPaneProps {
  fileService: IFileService;
  path: string;
  remote?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onExit?: () => void;
}

/** 空白工作表：引擎在 data 为空时不渲染任何东西，首屏必须是"一张空表"。 */
function emptySheet(): Sheet[] {
  return [{ name: "Sheet1", status: 1, celldata: [], row: 60, column: 20 }];
}

const ALIGN_TO_CODE: Record<number, string> = { 1: "left", 0: "center", 2: "right" };

export function ExcelEditorPane({
  fileService,
  path,
  remote,
  onDirtyChange,
  onExit,
}: ExcelEditorPaneProps) {
  const apiRef = useRef<WorkbookInstance | null>(null);
  const [selectionStyle, setSelectionStyle] = useState<RibbonStyle | null>(null);
  const [selection, setSelection] = useState("");

  const getSheets = useCallback((): Sheet[] => apiRef.current?.getAllSheets() ?? [], []);

  const {
    status,
    setStatus,
    dirty,
    setDirty,
    busy,
    loadCount,
    writeBlocked,
    guard,
    sheets,
    loadDocument,
    save,
    recordStructureEdit,
  } = useExcelDocument({ fileService, path, remote, getSheets, onDirtyChange });

  /**
   * 功能区的按钮态：从**当前选区的左上角格子**读格式（Excel 也是这么显示的）。
   * 引擎没有"选区格式变了"的事件，所以每次选区/内容变化后主动读一次。
   */
  const syncSelectionStyle = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const range = api.getSelection()?.[0];
    const row = range?.row?.[0] ?? 0;
    const column = range?.column?.[0] ?? 0;
    const read = (type: string): unknown => api.getCellValue(row, column, { type } as never);
    const ht = read("ht");
    setSelectionStyle({
      bold: read("bl") === 1,
      italic: read("it") === 1,
      underline: read("un") === 1,
      strikeout: read("cl") === 1,
      font: (read("ff") as string | undefined) ?? undefined,
      size: (read("fs") as number | undefined) ?? undefined,
      color: (read("fc") as string | undefined) ?? null,
      highlight: (read("bg") as string | undefined) ?? null,
      rowFlex: typeof ht === "number" ? (ALIGN_TO_CODE[ht] ?? null) : null,
      undo: true,
      redo: true,
    });
    setSelection(selectionLabel(api));
  }, []);

  /**
   * 按钮态跟着选区/内容走：用引擎给的 `hooks.afterSelectionChange` / `afterUpdateCell`，
   * 而不是拿定时器去轮询（轮询既费又会在拖选时抖）。
   * hooks 的**对象身份必须稳定**（引擎在初始化时读它），所以用 ref 间接指向最新回调。
   */
  const syncRef = useRef(syncSelectionStyle);
  syncRef.current = syncSelectionStyle;
  const hooks = useMemo(
    () => ({
      afterSelectionChange: () => syncRef.current(),
      afterUpdateCell: () => syncRef.current(),
    }),
    [],
  );

  const runRibbon = useCallback(
    (command: string, args?: unknown[]) => {
      runExcelCommand(
        {
          api: () => apiRef.current,
          setStatus,
          getSheets,
          recordStructureEdit,
        },
        command,
        args ?? [],
      );
      syncSelectionStyle();
    },
    [getSheets, recordStructureEdit, setStatus, syncSelectionStyle],
  );

  const readOnly = guard?.readOnly === true || writeBlocked !== null;
  // 引擎的 data 是**非受控**的（只在挂载时读一次），所以：数据没到就不挂载，
  // 换文件/重新加载用 key 强制重建（见 useExcelDocument 的 loadCount）
  const data = useMemo(() => sheets ?? emptySheet(), [sheets]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OfficeEditorToolbar
        busy={busy}
        dirty={dirty}
        status={status}
        onSave={() => void save()}
        onReload={() => {
          void loadDocument().catch((error) => setStatus(`重新加载失败：${String(error)}`));
        }}
        onExit={onExit}
        confirmExit={() => !dirty || window.confirm("有未保存的修改，确定退出编辑吗？")}
        extra={
          selection ? (
            <span className="rounded border border-border px-2 py-1 text-foreground-subtle">
              {selection}
            </span>
          ) : null
        }
      />
      {writeBlocked ? (
        <div className="border-b border-border bg-surface px-3 py-3 text-xs">
          <div className="pb-1 font-medium">这份表格现在不能应用内编辑</div>
          <div className="text-foreground-subtle">{writeBlocked}</div>
        </div>
      ) : null}
      {guard && guard.notices.length > 0 ? (
        <div className="border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <div className="pb-1 font-medium">
            这份工作簿只提供只读（应用内保存会重写文件，下面这些会丢）：
          </div>
          <ul className="list-disc pl-5">
            {guard.notices.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <OfficeRibbon
        style={selectionStyle}
        run={runRibbon}
        tabs={EXCEL_RIBBON_TABS}
        hint={readOnly ? "只读：护栏命中或远端不支持写回" : undefined}
      />
      <div className="min-h-0 flex-1" onMouseUp={syncSelectionStyle} onKeyUp={syncSelectionStyle}>
        {sheets ? (
          <Workbook
            key={`${path}:${loadCount}`}
            ref={apiRef}
            data={data}
            allowEdit={!readOnly}
            showToolbar={false}
            showFormulaBar
            showSheetTabs
            lang="zh"
            hooks={hooks}
            // 脏标记只看 op（immer 补丁）：onChange 连选区变化都会触发，
            // 用它当 "未保存" 会让用户刚点一下格子就看到"未保存"（真机最忌讳这种假信号）
            onOp={() => setDirty(true)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-foreground-subtle">
            正在打开表格…
          </div>
        )}
      </div>
    </div>
  );
}
