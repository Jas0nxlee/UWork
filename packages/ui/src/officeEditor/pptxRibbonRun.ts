/**
 * PPT 功能区的**命令落点**：把功能区里的命令名接到编辑位已有的操作上。
 *
 * 与 Word/Excel 同一个思路（命令名 → 一层薄分发），差别是这里没有引擎、也没有撤销栈：
 * 每条命令都落到 `usePptxDocument` 的 XML 补丁上，所以"改了哪一页"由那份补丁自己记，
 * 保存时仍然只写回改过的页。**没有撤销**——所以"删除"这类命令在界面上一律先给确认。
 *
 * 命令名与参数由 `pptxRibbonTabs.ts` 声明，两边一起改；门禁里对每条命令都做了"不报错 + 有反应"的断言。
 */
import type { ShapeRunFormat } from "./pptShapes.js";
import type { PptxShape } from "./pptShapes.js";

/** 命令需要的编辑位能力（由 PptxEditorPane 传进来）。 */
export interface PptxRibbonApi {
  /** 当前页部件名（没有选中页时为 null）。 */
  partName: string | null;
  /** 当前选中的形状（没有就是 null）。 */
  shape: PptxShape | null;
  slideIndex: number;
  slideCount: number;
  addSlide: () => void;
  duplicateSlide: () => void;
  deleteSlide: () => void;
  moveSlide: (to: number) => void;
  addTextBox: () => void;
  duplicateShape: () => void;
  deleteShape: () => void;
  moveShape: (direction: "up" | "down") => void;
  setFormat: (format: ShapeRunFormat) => void;
  setParagraph: (format: {
    align?: "left" | "center" | "right" | "justify";
    bullet?: boolean;
  }) => void;
  setZoom: (updater: (value: number) => number) => void;
  /** 给状态栏留一句话（命令被拒时说明原因）。 */
  note: (message: string) => void;
}

/** 「加粗」这一类的当前状态：命中就关掉，否则打开（与 Word 功能区的行为一致）。 */
function toggle(current: boolean | undefined): boolean {
  return !current;
}

export function runPptxRibbonCommand(command: string, args: unknown[], api: PptxRibbonApi): void {
  const shape = api.shape;
  /** 需要选中形状的命令：没选中就说明原因，不假装做了。 */
  const needShape = (run: (shape: PptxShape) => void) => {
    if (!shape) {
      api.note("先在画布上点一个形状，或从右侧形状列表里选一个");
      return;
    }
    run(shape);
  };

  switch (command) {
    // —— 幻灯片 ——
    case "pptxAddSlide":
      api.addSlide();
      return;
    case "pptxDuplicateSlide":
      api.duplicateSlide();
      return;
    case "pptxDeleteSlide":
      if (api.slideCount <= 1) {
        api.note("这是唯一一页，删掉就没有了——先建一页再删");
        return;
      }
      if (window.confirm(`删除第 ${api.slideIndex + 1} 页？`)) api.deleteSlide();
      return;
    case "pptxMoveSlideUp":
      api.moveSlide(api.slideIndex - 1);
      return;
    case "pptxMoveSlideDown":
      api.moveSlide(api.slideIndex + 1);
      return;

    // —— 字体 / 段落（落到选中形状）——
    // 命令名与 Word/Excel 同名（executeBold / executeRowFlex / executeFont…）：
    // 于是"加粗亮不亮""左对齐亮不亮"直接复用 ribbonItemSupport 里现成的判定。
    case "executeBold":
      needShape((current) => api.setFormat({ bold: toggle(current.runFormat.bold) }));
      return;
    case "executeItalic":
      needShape((current) => api.setFormat({ italic: toggle(current.runFormat.italic) }));
      return;
    case "executeUnderline":
      needShape((current) => api.setFormat({ underline: toggle(current.runFormat.underline) }));
      return;
    case "executeStrikeout":
      needShape((current) => api.setFormat({ strike: toggle(current.runFormat.strike) }));
      return;
    case "executeFont": {
      const font = String(args[0] ?? "");
      needShape(() => api.setFormat({ font }));
      return;
    }
    case "executeSize": {
      const size = Number(args[0]);
      needShape(() => api.setFormat({ size: Number.isFinite(size) ? size : undefined }));
      return;
    }
    case "executeColor": {
      const color = args[0];
      if (color === null) {
        api.note("「自动」色暂时做不到——PPT 里这等于删掉 a:solidFill，留给下一步");
        return;
      }
      needShape(() => api.setFormat({ color: String(color) }));
      return;
    }
    case "executeRowFlex": {
      const align = args[0];
      if (align !== "left" && align !== "center" && align !== "right" && align !== "justify") {
        api.note(`段落对齐参数不认识：${String(align)}`);
        return;
      }
      needShape(() => api.setParagraph({ align }));
      return;
    }
    case "pptxToggleBullet":
      needShape((current) => {
        const paragraph = current.textBodies[0]?.[0];
        api.setParagraph({ bullet: paragraph?.bullet === true ? false : true });
      });
      return;

    // —— 形状 ——
    case "pptxAddTextBox":
      if (!api.partName) return;
      api.addTextBox();
      return;
    case "pptxDuplicateShape":
      needShape(() => api.duplicateShape());
      return;
    case "pptxDeleteShape":
      needShape((current) => {
        if (window.confirm(`删除形状「${current.name}」？`)) api.deleteShape();
      });
      return;
    case "pptxShapeUp":
      needShape(() => api.moveShape("up"));
      return;
    case "pptxShapeDown":
      needShape(() => api.moveShape("down"));
      return;

    // —— 视图 ——
    case "pptxZoomIn":
      api.setZoom((value) => Math.min(400, value + 25));
      return;
    case "pptxZoomOut":
      api.setZoom((value) => Math.max(25, value - 25));
      return;
    case "pptxZoomFit":
      api.setZoom(() => 100);
      return;
    case "pptxZoomReset": {
      const value = Number(args[0] ?? 100);
      api.setZoom(() => (Number.isFinite(value) && value > 0 ? value : 100));
      return;
    }
    default:
      api.note(`功能区命令「${command}」还没有接上`);
  }
}

/**
 * 功能区要显示的"当前样式"：从选中的形状读。
 * 只填我们真的能读回来的项（字体/字号/粗斜下划线/颜色），段落对齐按首个段落。
 */
export function pptxRibbonStyle(shape: PptxShape | null): {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  font?: string;
  size?: number;
  color?: string | null;
  rowFlex?: string | null;
} {
  if (!shape) return {};
  const paragraph = shape.textBodies[0]?.[0];
  const { strike, ...rest } = shape.runFormat;
  return {
    ...rest,
    // RibbonStyle 里叫 strikeout，OOXML 里叫 strike：这层映射就放在这里，别漏
    ...(strike ? { strikeout: true } : {}),
    ...(paragraph?.align ? { rowFlex: paragraph.align } : {}),
  };
}
