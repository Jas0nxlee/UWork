/**
 * 画布上的**右键菜单**（PowerPoint 里右键一个对象就是这个）。
 *
 * 为什么需要它：选中对象**不再自动弹**右栏窗格（真机反馈："只要弹出，主编辑界面就太小了"），
 * 于是"设置形状格式"必须有别的入口——右键菜单和顶部按钮。菜单里同时放几个最常用的形状操作，
 * 免得为了复制/删除还得先开窗格。
 *
 * 样式：定位用 inline style（检查脚手架页没有 Tailwind），颜色用 class。
 */
export interface PptxContextMenuState {
  /** 相对**画布框**的坐标（不是视口坐标）。 */
  x: number;
  y: number;
  /** 右键点中的对象名（菜单本身不用它，编辑位按它下手）。 */
  name: string;
}

export interface PptxCanvasContextMenuProps {
  menu: PptxContextMenuState | null;
  /** 选中的是表格（菜单文案跟着变：表格设置）。 */
  inTable: boolean;
  onClose: () => void;
  onOpenFormatPane: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveZ: (direction: "up" | "down") => void;
}

export function PptxCanvasContextMenu(props: PptxCanvasContextMenuProps) {
  if (!props.menu) return null;
  const item = (label: string, onClick: () => void, attr: string) => (
    <button
      type="button"
      data-pptx-canvas-menu-item={attr}
      className="block w-full whitespace-nowrap rounded px-3 py-1 text-left text-[12px] hover:bg-hover"
      onClick={() => {
        onClick();
        props.onClose();
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      data-pptx-canvas-menu
      className="rounded border border-border bg-background py-1 shadow-2xl"
      style={{
        position: "absolute",
        left: props.menu.x,
        top: props.menu.y,
        zIndex: 40,
        minWidth: 168,
      }}
      // 菜单自己吃掉点击，别让画布把选区取消掉
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {item(props.inTable ? "表格设置…" : "设置形状格式…", props.onOpenFormatPane, "format")}
      {item("复制", props.onDuplicate, "duplicate")}
      {item("上移一层", () => props.onMoveZ("up"), "up")}
      {item("下移一层", () => props.onMoveZ("down"), "down")}
      {item("删除", props.onDelete, "delete")}
    </div>
  );
}
