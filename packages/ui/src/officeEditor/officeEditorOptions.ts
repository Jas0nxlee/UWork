/**
 * 编辑器的构造参数（编辑位与回归检查共用一份）。
 *
 * ⚠️ 引擎构造函数是 `new Editor(容器, 数据, 选项)` **三个参数**。我们此前把选项当第二个参数（数据）
 * 传了很久——引擎把它当 IEditorData 读（恰好有 `main` 所以文档能显示），于是 margins/选区色/
 * 控件定界符这些**选项从来没生效**（真机反馈的内容控件花括号就是引擎默认 `prefix:"{"`）。
 * 所以这里把"初始数据"与"选项"分开导出，杜绝再传错位置。
 *
 * 收口在这里的原因：有几项默认值直接决定"看起来对不对"，分散在两处就会漂——
 *   - `control.prefix/postfix`：引擎默认给内容控件加 `{` `}` 花括号（`prefix:"{"`、`postfix:"}"`），
 *     Word 不是这样：Word 用**浅色底纹**表示控件范围，没有定界符。所以清空定界符、改用底色区分。
 *   - 深色主题下 `bracketColor/placeholderColor` 的默认黑色看不见，要按应用配色覆盖。
 *   - 选区色：引擎默认 `#AECBFA@60%` 在深色底上太弱，看起来像"字没了"（真机反馈）。
 */
export interface EditorOptionOverrides {
  /** 滚动容器选择器：编辑位用 `#office-editor-scroll`，检查脚本用自己的 host。 */
  scrollContainerSelector?: string;
}

/**
 * 内容控件的观感：看不见定界符、空值/有值/聚焦各一档浅底，占位文字灰一点。
 *
 * 定界符用**零宽空格**而不是空串：实测空串会让 `getValue()` 认不出控件
 * （引擎靠 prefix/postfix 组件把控件分块重组，定界符为空时控件在取值里直接消失；
 * 导出/写回都读取值，所以不能省）。零宽空格在画布上不占宽也不显形，效果等同"没有定界符"。
 */
export const CONTROL_OPTIONS = {
  prefix: "\u200b",
  postfix: "\u200b",
  placeholderColor: "#8b8b8b",
  bracketColor: "#8b8b8b",
  borderWidth: 1,
  borderColor: "#3a3a3a",
  activeBackgroundColor: "rgba(56, 139, 253, 0.18)",
  existValueBackgroundColor: "rgba(255, 255, 255, 0.05)",
  noValueBackgroundColor: "rgba(255, 255, 255, 0.03)",
  errorBackgroundColor: "rgba(248, 81, 73, 0.18)",
} as const;

/** 初始文档数据（构造函数的第二个参数）。 */
export function createInitialData() {
  return { main: [{ value: "" }] };
}

/** 编辑器选项（构造函数的第三个参数）。 */
export function createEditorOptions(overrides: EditorOptionOverrides = {}) {
  return {
    // 页面观感贴近 Office：A4 纸张 + 页边距 + 分页
    pageMode: "paging" as const,
    margins: [100, 120, 100, 120],
    // 滚动必须显式交给外层容器（默认也是父节点，这里写明意图；配合容器的 overflow-auto）
    scrollContainerSelector: overrides.scrollContainerSelector ?? "#office-editor-scroll",
    rangeColor: "#0969da",
    rangeAlpha: 0.25,
    control: { ...CONTROL_OPTIONS },
  };
}
