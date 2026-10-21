/**
 * canvas-editor 的元素/数据形状（只写我们用到的字段）。
 *
 * 为什么不直接用 `@hufe921/canvas-editor` 的类型：它的 `.d.ts` 只导出 Editor 与少数枚举，
 * 元素与数据形状在 `dist/src/editor/interface/*.d.ts` 里、没有从包入口再导出；
 * 为了不写 `any`，这里按引擎源码里**真实用到**的字段声明一份最小集合（多一个字段都不会被读到）。
 */
export interface IControlConfig {
  type: "text" | "select" | "checkbox" | "radio" | "date" | "number";
  value?: IElement[] | null;
  placeholder?: string;
  code?: string | null;
  valueSets?: Array<{ value: string; code: string }>;
  isMultiSelect?: boolean;
  flexDirection?: "row" | "column";
  date?: { dateFormat?: string };
  number?: { numberExclusiveOptions?: { calculatorDisabled?: boolean } };
  deletable?: boolean;
  disabled?: boolean;
  pasteDisabled?: boolean;
}

export interface IElement {
  value: string;
  type?: string;
  control?: IControlConfig;
  controlId?: string;
  checkbox?: { value: boolean; code?: string };
  dateFormat?: string;
  valueList?: IElement[];
  laTexSVG?: string;
  dateId?: string;
  id?: string;
}

export interface IEditorData {
  main: IElement[];
}
