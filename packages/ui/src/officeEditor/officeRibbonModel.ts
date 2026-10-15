/**
 * 编辑功能区的数据模型：分组 / 按钮 / 下拉，命令名与参数形态**照抄 canvas-editor 官方 demo**
 * （Hufe921/canvas-editor 的 src/main.ts，2477 行 vanilla TS 实现的 Word 级工具栏），
 * 只把它的信息架构搬成数据 + React 渲染，不自己发明命令或参数。
 *
 * 选中的命令名与参数来自官方实现中的调用处：
 * - 行距 `executeRowMargin(数字)`；段前/段后 `executeSpacingBefore/After(数字)`
 * - 对齐 `executeRowFlex('left'|'center'|'right'|'alignment')`（RowFlex 枚举）
 * - 标题 `executeTitle('h1'..'h6' | null)`；列表 `executeList('ul'|'ol'|'task')`
 * - 页面 `executeSetPaperMargin([上,右,下,左])`、`executeSetColumns({count,gap,separator})`、`executePaperSize/paperDirection`
 * - 插入控件 `executeInsertControl({ type:'control', value:'', control:{ type:'select'|'checkbox'|'radio'|'date'|'number', ... } })`
 * - 其余插入走 `executeInsertElementList([{ type: <ElementType>, ... }])`
 */

export interface RibbonStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  painter?: boolean;
  undo?: boolean;
  redo?: boolean;
  rowFlex?: string | null;
  level?: string | null;
  listType?: string | null;
  font?: string;
  size?: number;
  color?: string | null;
  highlight?: string | null;
}

export interface RibbonCommand {
  kind: "command";
  label: string;
  title: string;
  command: string;
  args?: unknown[];
  /** 输入型命令（超链接/图片/水印这类需要一句话参数）用 prompt 取参，取到后填进 args 的对应位置。 */
  prompt?: { message: string; at: number };
}

export interface RibbonSelect {
  kind: "select";
  label: string;
  title: string;
  options: Array<{ label: string; args: unknown[] }>;
  /** 当前值回显（与 style 对齐时高亮选项）。 */
  current?: (style: RibbonStyle) => string | null;
}

export type RibbonItem = RibbonCommand | RibbonSelect;

export interface RibbonGroup {
  label: string;
  items: RibbonItem[];
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
  /** 只在表格内可用（选中表格时自动切过去）。 */
  contextual?: boolean;
}

const COLORS = [
  "rgb(0, 0, 0)",
  "rgb(38, 38, 38)",
  "rgb(115, 115, 115)",
  "rgb(217, 38, 38)",
  "rgb(230, 126, 34)",
  "rgb(241, 196, 15)",
  "rgb(46, 139, 87)",
  "rgb(41, 128, 185)",
  "rgb(52, 73, 94)",
  "rgb(142, 68, 173)",
  "rgb(255, 255, 255)",
  "rgb(255, 221, 221)",
  "rgb(255, 236, 179)",
  "rgb(211, 247, 211)",
  "rgb(204, 229, 255)",
  "rgb(233, 222, 255)",
];

const FONTS = [
  "宋体",
  "仿宋",
  "黑体",
  "微软雅黑",
  "楷体",
  "等线",
  "SimSun",
  "Times New Roman",
  "Arial",
  "Calibri",
];

const SIZES = [9, 10.5, 11, 12, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48, 56, 72];

const TITLES: Array<{ label: string; args: unknown[] }> = [
  { label: "正文", args: [null] },
  { label: "标题 1", args: ["h1"] },
  { label: "标题 2", args: ["h2"] },
  { label: "标题 3", args: ["h3"] },
  { label: "标题 4", args: ["h4"] },
  { label: "标题 5", args: ["h5"] },
  { label: "标题 6", args: ["h6"] },
];

const ROW_MARGINS = [1, 1.15, 1.5, 2, 2.5, 3].map((ratio) => ({
  label: `${ratio} 倍行距`,
  args: [Math.round(ratio * 24)],
}));

const CONTROL_TYPES: Array<{ label: string; args: unknown[] }> = [
  { label: "文本控件", args: ["text"] },
  { label: "列举控件", args: ["select"] },
  { label: "复选框控件", args: ["checkbox"] },
  { label: "单选框控件", args: ["radio"] },
  { label: "日期控件", args: ["date"] },
  { label: "数字控件", args: ["number"] },
];

const PAPER_SIZES: Array<{ label: string; args: unknown[] }> = [
  { label: "A4（纵向尺寸）", args: ["A4"] },
  { label: "A3", args: ["A3"] },
  { label: "A5", args: ["A5"] },
  { label: "B5", args: ["B5"] },
];

const PAPER_DIRECTIONS: Array<{ label: string; args: unknown[] }> = [
  { label: "纵向", args: ["vertical"] },
  { label: "横向", args: ["horizontal"] },
];

const MARGINS: Array<{ label: string; args: unknown[] }> = [
  { label: "常规（100/120）", args: [[100, 120, 100, 120]] },
  { label: "窄（60/60）", args: [[60, 60, 60, 60]] },
  { label: "宽（160/200）", args: [[160, 200, 160, 200]] },
];

const COLUMN_PRESETS: Array<{ label: string; args: unknown[] }> = [
  { label: "单栏", args: [{ count: 1, gap: 30, separator: false }] },
  { label: "两栏", args: [{ count: 2, gap: 30, separator: false }] },
  { label: "两栏＋分隔线", args: [{ count: 2, gap: 30, separator: true }] },
  { label: "三栏", args: [{ count: 3, gap: 24, separator: false }] },
];

const button = (
  label: string,
  title: string,
  command: string,
  args?: unknown[],
  prompt?: RibbonCommand["prompt"],
): RibbonCommand => ({ kind: "command", label, title, command, ...(args ? { args } : {}), ...(prompt ? { prompt } : {}) });

export const RIBBON_TABS: RibbonTab[] = [
  {
    id: "home",
    label: "开始",
    groups: [
      {
        label: "历史",
        items: [
          button("撤销", "撤销 (⌘Z)", "executeUndo"),
          button("重做", "重做 (⇧⌘Z)", "executeRedo"),
          button("格式刷", "格式刷：先选中带格式的文字，再点要套用的文字", "executePainter"),
          button("清格式", "清除格式", "executeFormat"),
        ],
      },
      {
        label: "字体",
        items: [
          {
            kind: "select",
            label: "字体",
            title: "字体",
            options: FONTS.map((font) => ({ label: font, args: [font] })),
            current: (style) => style.font ?? null,
          },
          {
            kind: "select",
            label: "字号",
            title: "字号",
            options: SIZES.map((size) => ({ label: String(size), args: [size] })),
            current: (style) => (style.size ? String(style.size) : null),
          },
          button("A+", "增大字号", "executeSizeAdd"),
          button("A−", "减小字号", "executeSizeMinus"),
          button("B", "加粗 (⌘B)", "executeBold"),
          button("I", "斜体 (⌘I)", "executeItalic"),
          button("U", "下划线 (⌘U)", "executeUnderline"),
          button("S", "删除线", "executeStrikeout"),
          button("x²", "上标", "executeSuperscript"),
          button("x₂", "下标", "executeSubscript"),
          {
            kind: "select",
            label: "字色",
            title: "文字颜色",
            options: [{ label: "自动", args: [null] }, ...COLORS.map((color) => ({ label: color, args: [color] }))],
            current: (style) => style.color ?? null,
          },
          {
            kind: "select",
            label: "底纹",
            title: "高亮（底纹）",
            options: [{ label: "无", args: [null] }, ...COLORS.map((color) => ({ label: color, args: [color] }))],
            current: (style) => style.highlight ?? null,
          },
        ],
      },
      {
        label: "段落",
        items: [
          button("左", "左对齐 (⌘L)", "executeRowFlex", ["left"]),
          button("中", "居中 (⌘E)", "executeRowFlex", ["center"]),
          button("右", "右对齐 (⌘R)", "executeRowFlex", ["right"]),
          button("两端", "两端对齐 (⌘J)", "executeRowFlex", ["alignment"]),
          {
            kind: "select",
            label: "行距",
            title: "行距",
            options: ROW_MARGINS,
          },
          button("段前−", "减小段前间距", "executeSpacingBefore", [-6]),
          button("段前+", "增大段前间距", "executeSpacingBefore", [6]),
          button("段后−", "减小段后间距", "executeSpacingAfter", [-6]),
          button("段后+", "增大段后间距", "executeSpacingAfter", [6]),
          {
            kind: "select",
            label: "标题",
            title: "标题级别",
            options: TITLES,
            current: (style) => style.level ?? null,
          },
          {
            kind: "select",
            label: "列表",
            title: "项目符号与编号",
            options: [
              { label: "无序（•）", args: ["ul"] },
              { label: "有序（1.）", args: ["ol"] },
              { label: "任务列表（☑）", args: ["task"] },
            ],
            current: (style) => style.listType ?? null,
          },
        ],
      },
    ],
  },
  {
    id: "insert",
    label: "插入",
    groups: [
      {
        label: "表格",
        items: [
          button("3×3", "插入 3×3 表格", "executeInsertTable", [3, 3]),
          button("5×4", "插入 5×4 表格", "executeInsertTable", [5, 4]),
        ],
      },
      {
        label: "插图与链接",
        items: [
          button("图片", "插入图片（图片地址）", "executeImage", undefined, {
            message: "图片地址（http/https 或 data:）",
            at: 0,
          }),
          button("超链接", "插入/编辑超链接", "executeHyperlink", undefined, {
            message: "链接地址",
            at: 0,
          }),
          button("LaTeX", "插入 LaTeX 公式", "executeLatex", undefined, {
            message: "LaTeX 公式（如 E=mc^2）",
            at: 0,
          }),
        ],
      },
      {
        label: "控件",
        items: [
          {
            kind: "select",
            label: "控件",
            title: "插入内容控件",
            options: CONTROL_TYPES,
          },
          button("日期", "插入当前日期", "executeInsertElementList", [{ type: "date", value: "", dateFormat: "yyyy-MM-dd" }]),
          button("复选框", "插入复选框", "executeInsertElementList", [{ type: "checkbox", value: false, checkbox: { value: false } }]),
          button("代码块", "插入代码块", "executeInsertElementList", [{ type: "codeblock", value: "", codeBlock: { language: "javascript" } }]),
          button("引用块", "插入引用块", "executeInsertElementList", [{ type: "blockquote", value: "", blockquote: { showLine: true } }]),
        ],
      },
      {
        label: "页面元素",
        items: [
          button("分隔线", "插入分隔线", "executeSeparator", ["separator"]),
          button("分页符", "插入分页符", "executePageBreak", ["pageBreak"]),
          button("水印", "添加水印", "executeAddWatermark", undefined, {
            message: "水印文字（留空则用默认）",
            at: 0,
          }),
          button("去水印", "删除水印", "executeDeleteWatermark"),
          button("分栏", "分栏", "executeSetColumns", [{ count: 2, gap: 30, separator: false }]),
        ],
      },
    ],
  },
  {
    id: "table",
    label: "表格",
    contextual: true,
    groups: [
      {
        label: "行列",
        items: [
          button("上方插行", "在上方插入行", "executeInsertTableTopRow"),
          button("下方插行", "在下方插入行", "executeInsertTableBottomRow"),
          button("左侧插列", "在左侧插入列", "executeInsertTableLeftCol"),
          button("右侧插列", "在右侧插入列", "executeInsertTableRightCol"),
          button("删行", "删除当前行", "executeDeleteTableRow"),
          button("删列", "删除当前列", "executeDeleteTableCol"),
          button("删表", "删除整个表格", "executeDeleteTable"),
        ],
      },
      {
        label: "单元格",
        items: [
          button("合并", "合并单元格", "executeMergeTableCell"),
          button("横拆", "水平拆分单元格", "executeSplitHorizontalTableCell"),
          button("竖拆", "垂直拆分单元格", "executeSplitVerticalTableCell"),
          button("全选表", "选中整个表格", "executeTableSelectAll"),
          {
            kind: "select",
            label: "单元格底色",
            title: "单元格底色",
            options: [{ label: "无", args: [null] }, ...COLORS.map((color) => ({ label: color, args: [color] }))],
          },
          {
            kind: "select",
            label: "垂直对齐",
            title: "单元格垂直对齐",
            options: [
              { label: "顶端", args: ["top"] },
              { label: "居中", args: ["middle"] },
              { label: "底端", args: ["bottom"] },
            ],
          },
        ],
      },
      {
        label: "自适应",
        items: [
          button("适应内容", "表格宽度适应内容", "executeTableAutoFitToContent"),
          button("适应页面", "表格宽度适应页面", "executeTableAutoFitToPage"),
        ],
      },
    ],
  },
  {
    id: "layout",
    label: "布局",
    groups: [
      {
        label: "页面",
        items: [
          { kind: "select", label: "纸张", title: "纸张大小", options: PAPER_SIZES },
          { kind: "select", label: "方向", title: "纸张方向", options: PAPER_DIRECTIONS },
          { kind: "select", label: "页边距", title: "页边距", options: MARGINS },
          { kind: "select", label: "分栏", title: "分栏", options: COLUMN_PRESETS },
        ],
      },
    ],
  },
  {
    id: "view",
    label: "视图",
    groups: [
      {
        label: "显示",
        items: [
          button("缩放−", "缩小", "executePageScaleMinus"),
          button("100%", "恢复缩放", "executePageScaleRecovery"),
          button("缩放+", "放大", "executePageScaleAdd"),
          button("标尺", "显示/隐藏标尺", "executeToggleRuler"),
          button("连页/分页", "切换连页与分页视图", "executePageMode"),
          button("痕迹", "显示/隐藏修订与格式痕迹", "executeToggleTrace"),
          button("只读", "切换只读模式", "executeMode"),
        ],
      },
      {
        label: "工具",
        items: [
          button("字数", "字数统计", "executeWordTool"),
          button("查找替换", "查找替换 (⌘F)", "executeSearch"),
          button("打印", "打印 (⌘P)", "executePrint"),
        ],
      },
    ],
  },
];
