/**
 * 画布的 props（从 `PptxSlideCanvas.tsx` 挪出来，那个文件有 400 行上限）。
 *
 * 与画布本身一一对应：几何相关的一律 EMU，缩放用百分比，交互回调只报告"用户想干什么"，
 * 写回 XML 是编辑位的事。
 */
import type { PptxShape } from "./pptShapes.js";
import type { PptxPreviewState } from "./usePptxPreview.js";

export interface PptxSlideCanvasProps {
  /** 共享的预览文档（一份文件只解析一次）。 */
  preview: PptxPreviewState;
  /** 渲染器页序号（编辑位用 `preview.pageIndexOf` 从部件名换出来）。 */
  pageIndex: number;
  /** 这一页的部件名（换页时用来重挂渲染面）。 */
  partName: string;
  /** 从 XML 读出的形状：**点选名单**以它为准。 */
  shapes: PptxShape[];
  activeShape: string | null;
  onSelect: (name: string | null) => void;
  onCommitBounds: (
    name: string,
    bounds: { x?: number; y?: number; width?: number; height?: number; rotation?: number },
  ) => void;
  /** 双击：希望就地改这个形状的文字（编辑位负责把焦点移到编辑层）。 */
  onRequestText?: (name: string) => void;
  /** 点中了表格的某一格（表格名 / 行 / 列，0 基）。 */
  onSelectCell?: (table: string, row: number, col: number) => void;
  /** 双击某一格：就地改这一格的文字。 */
  onEditCell?: (table: string, row: number, col: number) => void;
  /** 选中的**一片**单元格（1×1 就是只选了一格）：在表格里按住拖就能选一片。 */
  cellRange?: { table: string; row0: number; col0: number; row1: number; col1: number } | null;
  /** 拖到另一格：把选区扩到（表格名 / 行 / 列）。 */
  onExtendCell?: (table: string, row: number, col: number) => void;

  /**
   * 改动版本号（编辑位每次改 XML 都会 +1）：只靠"预览字节变了"来触发重画不够可靠——
   * 真机实测：删掉图片后形状列表已经没了，画布上那张图还在（等几秒也不消失），
   * 而关闭面板之类的布局变化才把它刷掉。这个 key 保证**每次改动都重画一次**。
   */
  renderKey: number;
  /** 缩放百分比（100 = 适应宽度）：由编辑位持有，功能区「视图」也要改它。 */
  zoom: number;
  onZoomChange: (updater: (value: number) => number) => void;
  /** 打开右侧「设置形状格式」窗格（窗格默认收起，免得把画布挤窄）。 */
  onOpenFormatPane: () => void;
  /** 就地改字（双击形状/单元格进入）：null 表示不在编辑；`cell` 有值表示改的是表格某一格。 */
  editing: { shape: string; text: string; cell?: { row: number; col: number } } | null;
  onEditingText: (text: string) => void;
  onEditingCommit: () => void;
  onEditingCancel: () => void;
}
