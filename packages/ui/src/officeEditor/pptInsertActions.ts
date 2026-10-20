/**
 * 两种"插入"的**纯入口**：插表格（改一页 XML）与插图片（改整份包）。
 *
 * 单独成文件的理由：编辑位那个 hook 要守 400 行；而这里也确实只是"把参数摆成写入侧要的形状"，
 * 不掺任何状态。
 */
import { useCallback } from "react";
import { insertPicture } from "./pptPicture.js";
import { insertTable } from "./pptTableInsert.js";
import {
  applyTableStructureEdit,
  mergeCell,
  setCellBorder,
  setCellFill,
  setTableOptions,
  splitCell,
  tableOptionsOf,
} from "./pptTable.js";

/** 插表格：只动这一页的 XML。 */
export function patchTableXml(
  xml: string,
  rows: number,
  cols: number,
  pageWidth: number,
  pageHeight: number,
): string {
  return insertTable(xml, { rows, cols, pageWidth, pageHeight }).xml;
}

/** 插图片：新增媒体部件 + 这一页 rels + `p:pic`，所以换的是整份包的字节。 */
export async function patchPictureBytes(
  source: ArrayBuffer,
  input: { partName: string; dataUri: string; pageWidth: number; pageHeight: number },
): Promise<ArrayBuffer> {
  const result = await insertPicture({ source, ...input });
  return result.bytes;
}

/** 表格工具的命令名 → 纯函数（编辑位只负责把它们接到"改这一页 XML"的通道上）。 */
export const TABLE_COMMAND_LABEL: Record<string, string> = {
  pptxTableInsertRowAbove: "上方插入行",
  pptxTableInsertRowBelow: "下方插入行",
  pptxTableInsertColumnLeft: "左侧插入列",
  pptxTableInsertColumnRight: "右侧插入列",
  pptxTableDeleteRow: "删除行",
  pptxTableDeleteColumn: "删除列",
  pptxTableMergeRight: "向右合并",
  pptxTableMergeDown: "向下合并",
  pptxTableSplit: "拆分单元格",
  pptxTableCellBorderOn: "加边框",
  pptxTableCellBorderOff: "去边框",
  pptxTableFirstRow: "切换首行突出",
  pptxTableBandRow: "切换镶边行",
  executeHighlight: "设置底纹",
};

export function applyTableCommand(
  xml: string,
  table: string,
  row: number,
  col: number,
  command: string,
  args: unknown[],
): string {
  const colour = typeof args[0] === "string" ? args[0] : null;
  switch (command) {
    case "pptxTableInsertRowAbove":
      return applyTableStructureEdit(xml, table, row, col, { kind: "insertRowAbove" });
    case "pptxTableInsertRowBelow":
      return applyTableStructureEdit(xml, table, row, col, { kind: "insertRowBelow" });
    case "pptxTableInsertColumnLeft":
      return applyTableStructureEdit(xml, table, row, col, { kind: "insertColumnLeft" });
    case "pptxTableInsertColumnRight":
      return applyTableStructureEdit(xml, table, row, col, { kind: "insertColumnRight" });
    case "pptxTableDeleteRow":
      return applyTableStructureEdit(xml, table, row, col, { kind: "deleteRow" });
    case "pptxTableDeleteColumn":
      return applyTableStructureEdit(xml, table, row, col, { kind: "deleteColumn" });
    case "pptxTableMergeRight":
      return mergeCell(xml, table, row, col, "right");
    case "pptxTableMergeDown":
      return mergeCell(xml, table, row, col, "down");
    case "pptxTableSplit":
      return splitCell(xml, table, row, col);
    case "executeHighlight":
      return setCellFill(xml, table, row, col, colour);
    case "pptxTableCellBorderOn":
      return setCellBorder(xml, table, row, col, { on: true, color: "000000", width: 12700 });
    case "pptxTableCellBorderOff":
      return setCellBorder(xml, table, row, col, { on: false });
    case "pptxTableFirstRow": {
      const current = tableOptionsOf(xml, table);
      return setTableOptions(xml, table, { firstRow: !(current?.firstRow ?? true) });
    }
    case "pptxTableBandRow": {
      const current = tableOptionsOf(xml, table);
      return setTableOptions(xml, table, { bandRow: !(current?.bandRow ?? true) });
    }
    default:
      return xml;
  }
}

/** 表格相关的两个动作（插表格、表格工具）：只依赖"改这一页 XML"这一个通道。 */
export function useTableActions(
  patchSlideXml: (partName: string, patch: (xml: string) => string, label: string) => void,
) {
  const insertTableAction = useCallback(
    (partName: string, rows: number, cols: number, w: number, h: number) =>
      patchSlideXml(
        partName,
        (xml) => patchTableXml(xml, rows, cols, w, h),
        `插入 ${rows}×${cols} 表格`,
      ),
    [patchSlideXml],
  );
  const tableOpAction = useCallback(
    (partName: string, table: string, row: number, col: number, command: string, args: unknown[]) =>
      patchSlideXml(
        partName,
        (xml) => applyTableCommand(xml, table, row, col, command, args),
        `表格：${TABLE_COMMAND_LABEL[command] ?? command}`,
      ),
    [patchSlideXml],
  );
  return { insertTableAction, tableOpAction };
}
