/**
 * 引擎的"参数形态"与几个引擎没提供的能力，集中在这里。
 *
 * 为什么单独一个文件：canvas-editor 的命令**参数形态很挑**，而且有几处只看名字猜不对
 * （纸张要像素不是 "A4"、控件要整套 valueSets 否则插出来六种长得一样、`executeWordTool` 其实是
 * "清理零宽空格"不是字数统计、`executeSearch/executeReplace` 需要宿主自己提供 UI 与替换实现）。
 * 这些坑都靠无头探针实测确认过，写在注释里免得再踩。
 */
import type { IElement, IEditorData } from "./engineTypes.js";

export interface EngineCommand {
  [name: string]: ((...args: unknown[]) => unknown) | undefined;
}

/** 控件类型 → 插入用的完整配置（只给 type 的话六种控件长得一模一样，这是真机反馈的"每一个都一样"）。 */
export function controlPayload(type: string): IElement {
  const base = { deletable: true, disabled: false, pasteDisabled: false } as const;
  const options = [
    { value: "选项一", code: "1" },
    { value: "选项二", code: "2" },
  ];
  switch (type) {
    case "select":
      return {
        type: "control",
        value: "",
        control: {
          type: "select",
          value: null,
          placeholder: "请选择",
          code: null,
          isMultiSelect: false,
          valueSets: options,
          ...base,
        },
      };
    case "checkbox":
      return {
        type: "control",
        value: "",
        control: {
          type: "checkbox",
          value: null,
          placeholder: "复选框",
          code: null,
          flexDirection: "row",
          valueSets: options,
          ...base,
        },
      };
    case "radio":
      return {
        type: "control",
        value: "",
        control: {
          type: "radio",
          value: null,
          placeholder: "单选框",
          code: null,
          flexDirection: "row",
          valueSets: options,
          ...base,
        },
      };
    case "date":
      return {
        type: "control",
        value: "",
        control: {
          type: "date",
          value: null,
          placeholder: "请选择日期",
          date: { dateFormat: "yyyy-MM-dd" },
          ...base,
        },
      };
    case "number":
      return {
        type: "control",
        value: "",
        control: {
          type: "number",
          value: null,
          placeholder: "数字",
          number: { numberExclusiveOptions: { calculatorDisabled: false } },
          ...base,
        },
      };
    default:
      return {
        type: "control",
        value: "",
        control: { type: "text", value: null, placeholder: "文本控件", ...base },
      };
  }
}

/** 单勾选框控件（Word 的「复选框控件」就是一个可勾的方框 + 一个选项）。 */
export function singleCheckboxPayload(): IElement {
  return {
    type: "control",
    value: "",
    control: {
      type: "checkbox",
      value: null,
      placeholder: "复选框",
      code: null,
      flexDirection: "row",
      valueSets: [{ value: "复选框", code: "1" }],
      deletable: true,
      disabled: false,
      pasteDisabled: false,
    },
  };
}

/** 日期控件（点开是日期选择器，未选时显示占位文字）。 */
export function dateControlPayload(): IElement {
  return {
    type: "control",
    value: "",
    control: {
      type: "date",
      value: null,
      placeholder: "请选择日期",
      date: { dateFormat: "yyyy-MM-dd" },
      deletable: true,
      disabled: false,
      pasteDisabled: false,
    },
  };
}

/**
 * 公式元素：只给 LaTeX 源码即可——**引擎自己**会用内置的数学排版器转 SVG
 * （`convertLaTextToSVG`，见引擎元素预处理），我们再传 `laTexSVG` 反而会被覆盖。
 */
export function latexElement(value: string): IElement {
  return { type: "latex", value };
}

/** 纸张尺寸按**引擎自己的像素口径**（96dpi）：它内置只认这三组，其它按像素走打印 @page。 */
export const PAPER_PRESETS: Record<string, { width: number; height: number }> = {
  A4: { width: 794, height: 1123 },
  A3: { width: 1125, height: 1593 },
  A5: { width: 565, height: 796 },
  // 引擎没有内置映射 → 打印时按像素尺寸处理（ISO B5 176×250mm @96dpi）
  B5: { width: 665, height: 945 },
};

/** 文档文本（只取文字元素，用于字数/字符数统计）。 */
export function documentText(data: Partial<IEditorData> | undefined): string {
  const main = data?.main ?? [];
  let text = "";
  for (const element of main) {
    if (typeof element?.value === "string") text += element.value;
  }
  return text;
}

/** 字符数（不含空白）与段落数，配合引擎 `getWordCount()` 的"字数"一起显示。 */
export function textStats(text: string): { chars: number; paragraphs: number } {
  const chars = text.replace(/\s/g, "").length;
  const paragraphs = text.split("\n").filter((line) => line.trim().length > 0).length;
  return { chars, paragraphs };
}
