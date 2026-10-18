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
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/**
 * 把工作簿挂到**它自己的 React root** 里。
 *
 * 为什么这么做：真机反馈"点单元格选不中/跳回 A1"，查下来是引擎的"行列 ↔ 像素"命中表算成了 NaN
 * （名字框显示 `A1:NaN`）。对照实验里，同一个引擎版本、同一套 props：
 *   - 单独挂在一个 React root 里（就是本组件这种形状）→ 正常；
 *   - 嵌在编辑位的组件树里 → 必现。
 * 所以宿主改成"编辑位管自己的状态，引擎在自己的 root 里跑"，两边互不干扰；
 * 引擎实例仍然通过 `apiRef` 交回给编辑位（功能区、保存、上报脏标记都用它）。
 */
function EngineHost({
  hostRef,
  apiRef,
  data,
  allowEdit,
  hooks,
  onOp,
  cacheKey,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>;
  apiRef: React.RefObject<WorkbookInstance | null>;
  data: Sheet[];
  allowEdit: boolean;
  hooks: { afterSelectionChange: () => void; afterUpdateCell: () => void };
  onOp: () => void;
  /** 换文件/重新加载时用它强制重建（对应原来挂在 <Workbook key> 上的那个键）。 */
  cacheKey: string;
}) {
  const onOpRef = useRef(onOp);
  onOpRef.current = onOp;
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = createRoot(host);
    root.render(
      <Workbook
        ref={apiRef as never}
        data={data}
        allowEdit={allowEdit}
        showToolbar={false}
        showFormulaBar
        showSheetTabs
        lang="zh"
        hooks={hooksRef.current}
        onOp={() => onOpRef.current()}
      />,
    );
    return () => {
      // **不能在这里同步销毁另一个 root**：React 会报 "Attempted to synchronously unmount a root
      // while React was already rendering"，而且 DOM 拆不干净（removeChild 报错、残留一份画布）。
      // 推到本轮渲染结束之后再做，并把宿主清空——引擎的 canvas React 不会自己摘掉。
      window.setTimeout(() => {
        root.unmount();
        host.replaceChildren();
      }, 0);
    };
    // data 变了要重建（引擎只在挂载时吃一次 data）；其余 props 走 ref，避免无谓重建
  }, [apiRef, data, hostRef]);
  return <div key={cacheKey} ref={hostRef} className="h-full w-full" />;
}

export function ExcelEditorPane({
  fileService,
  path,
  remote,
  onDirtyChange,
  onExit,
}: ExcelEditorPaneProps) {
  const apiRef = useRef<WorkbookInstance | null>(null);
  /** 引擎自己的宿主（见 EngineHost：引擎在自己的 React root 里跑）。 */
  const engineHostRef = useRef<HTMLDivElement | null>(null);
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
    // 切表/新建工作表的**瞬间**，引擎那张表还没有 data 矩阵，读格子会抛 SHEET_NOT_FOUND
    // （实测：点"新建工作表"就把编辑区弄崩、后面所有按钮跟着失效）。这种中间态跳过这一拍即可。
    const read = (type: string): unknown => {
      try {
        return api.getCellValue(row, column, { type } as never);
      } catch {
        return undefined;
      }
    };
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

  // 与 Word 编辑位同款：把引擎实例挂到 globalThis，真机排查（或自动化）时能直接读状态。
  // 卸载时清掉：不然排查会读到**已经死掉的实例**（表现为"点选区没反应"，冤枉活着的那个）。
  useEffect(() => {
    const global = globalThis as Record<string, unknown>;
    global.__officeExcelMounts = ((global.__officeExcelMounts as number) ?? 0) + 1;
    global.__officeExcelApi = apiRef;
    return () => {
      global.__officeExcelUnmounts = ((global.__officeExcelUnmounts as number) ?? 0) + 1;
      if (global.__officeExcelApi === apiRef) global.__officeExcelApi = null;
    };
  }, []);

  // 与 Word 编辑位同款：把引擎实例挂到 globalThis，真机排查（或自动化）时能直接读状态
  useEffect(() => {
    const global = globalThis as Record<string, unknown>;
    global.__officeExcelApi = apiRef;
    return () => {
      if (global.__officeExcelApi === apiRef) global.__officeExcelApi = null;
    };
  }, []);

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
          <EngineHost
            hostRef={engineHostRef}
            apiRef={apiRef}
            data={data}
            allowEdit={!readOnly}
            hooks={hooks}
            cacheKey={`${path}:${loadCount}`}
            // 脏标记只看 op（immer 补丁）：onChange 连选区变化都会触发，用它当"未保存"会假报；
            // 另外 onOp 是引擎在**渲染期**回调的，这里推到微任务再 setState（否则 React 会报
            // "边渲染边更新另一个组件"）
            onOp={() => queueMicrotask(() => setDirty(true))}
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
