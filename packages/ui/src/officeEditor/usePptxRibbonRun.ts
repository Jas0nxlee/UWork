/**
 * 功能区命令的**落点**：把 `pptxRibbonRun` 需要的编辑位能力（改形状/改页/缩放/表格…）装配起来。
 *
 * 单独成文件的理由：编辑位那个组件要守 400 行；这块是纯装配，不掺 JSX。
 */
import { useCallback } from "react";
import { runPptxRibbonCommand, type PptxRibbonApi } from "./pptxRibbonRun.js";
import type { PptxShape, ShapeRunFormat } from "./pptShapes.js";
import type { PptxSlide } from "./pptText.js";

export interface PptxRibbonRunInput {
  slide: PptxSlide | undefined;
  slides: PptxSlide[] | null;
  activeSlide: number;
  shape: PptxShape | null;
  previewFrame: () => { width: number; height: number };
  shapesOf: (partName: string) => PptxShape[];
  /** 选中的一片单元格（单选一格时两个角相同）。 */
  cellRange: {
    table: string;
    row0: number;
    col0: number;
    row1: number;
    col1: number;
  } | null;
  setZoom: (updater: (value: number) => number) => void;
  setStatus: (message: string) => void;
  addSlideAction: () => void;
  duplicateSlideAction: (partName: string) => void;
  deleteSlideAction: (partName: string) => void;
  moveSlideAction: (partName: string, to: number) => void;
  addTextBox: (partName: string) => void;
  duplicateShape: (partName: string, name: string) => void;
  removeShape: (partName: string, name: string) => void;
  moveShape: (partName: string, name: string, direction: "up" | "down") => void;
  setShapeFormat: (partName: string, name: string, format: ShapeRunFormat) => void;
  setShapeParagraph: (
    partName: string,
    name: string,
    format: { align?: "left" | "center" | "right" | "justify"; bullet?: boolean },
  ) => void;
  patchTable: (partName: string, rows: number, cols: number, w: number, h: number) => void;
  patchTableOp: (
    partName: string,
    table: string,
    row: number,
    col: number,
    command: string,
    args: unknown[],
  ) => void;
  insertPictureAction: (partName: string, dataUri: string, w: number, h: number) => void;
}

export function usePptxRibbonRun(input: PptxRibbonRunInput) {
  return useCallback(
    (command: string, args?: unknown[]) => {
      const partName = input.slide?.partName ?? null;
      const shape = input.shape;
      const api: PptxRibbonApi = {
        partName,
        shape,
        slideIndex: input.activeSlide,
        slideCount: input.slides?.length ?? 0,
        addSlide: () => input.addSlideAction(),
        duplicateSlide: () => partName && input.duplicateSlideAction(partName),
        deleteSlide: () => partName && input.deleteSlideAction(partName),
        moveSlide: (to) => partName && input.moveSlideAction(partName, to),
        addTextBox: () => partName && input.addTextBox(partName),
        duplicateShape: () => partName && shape && input.duplicateShape(partName, shape.name),
        deleteShape: () => partName && shape && input.removeShape(partName, shape.name),
        moveShape: (direction) =>
          partName && shape && input.moveShape(partName, shape.name, direction),
        setFormat: (format) =>
          partName && shape && input.setShapeFormat(partName, shape.name, format),
        // 开关类命令**现读**格式（见 pptxRibbonRun 里 runFormat 的注释）
        runFormat: () =>
          (partName ? input.shapesOf(partName).find((item) => item.name === shape?.name) : null)
            ?.runFormat ?? {},
        setParagraph: (format) =>
          partName && shape && input.setShapeParagraph(partName, shape.name, format),
        setZoom: input.setZoom,
        tableOp: (op, opArgs) => {
          if (!partName || shape?.kind !== "graphicFrame") {
            input.setStatus("先在画布上点进表格的某一格，再用表格工具");
            return;
          }
          const range = input.cellRange;
          // 「合并单元格」只选了一格时先说明白（否则会走到"没有实际变化"，用户不知道要先选一片）
          const rows = Math.abs((range?.row1 ?? 0) - (range?.row0 ?? 0));
          const cols = Math.abs((range?.col1 ?? 0) - (range?.col0 ?? 0));
          if (op === "pptxTableMergeRange" && rows === 0 && cols === 0) {
            input.setStatus("先在这片表格里按住拖，选出一片单元格再合并");
            return;
          }
          // 行列操作按**锚点**（选区左上角）定位；"合并一片"还要知道另一角，所以一并塞进参数
          const args =
            op === "pptxTableMergeRange"
              ? [
                  Math.max(range?.row0 ?? 0, range?.row1 ?? 0),
                  Math.max(range?.col0 ?? 0, range?.col1 ?? 0),
                ]
              : opArgs;
          input.patchTableOp(
            partName,
            shape.name,
            Math.min(range?.row0 ?? 0, range?.row1 ?? 0),
            Math.min(range?.col0 ?? 0, range?.col1 ?? 0),
            op,
            args,
          );
        },
        insertTable: (rows, cols) => {
          if (!partName) return;
          const size = input.previewFrame();
          input.setStatus(`插入 ${rows} × ${cols} 表格…`);
          input.patchTable(partName, rows, cols, size.width, size.height);
        },
        insertPicture: (dataUri) => {
          if (!partName) return;
          const size = input.previewFrame();
          input.insertPictureAction(partName, dataUri, size.width, size.height);
        },
        note: input.setStatus,
      };
      runPptxRibbonCommand(command, args ?? [], api);
    },
    [input],
  );
}
