/**
 * PPT 画布的**纯几何**：EMU ↔ 显示像素的换算、拖动/缩放的位移计算、手柄位置。
 *
 * 单独成文件的两个理由：① 组件文件要守 400 行；② 这些是能被断言钉住的纯函数
 * （真实踩过：渲染器给的是 96 dpi 像素不是 EMU，按 EMU 算会把位移放大 9525 倍；
 *  形状拖到页面外以后手柄跑出画布框、"看得见点不着"）。
 */

/** 96 dpi 像素 → EMU（914400 EMU/英寸 ÷ 96 px/英寸）。渲染器的 pageSize 与节点几何都是前者。 */
export const EMU_PER_PX = 9525;
/** 最小尺寸约 0.5 厘米：别让人把形状拖成 0（那样它就再也点不到了）。 */
export const MIN_EMU = 180000;
/** 画布框给页面留的边距。 */
export const PAGE_MARGIN_PX = 8;
/** 角手柄的边长与"骑在角上"的偏移。 */
export const HANDLE_SIZE = 12;
export const HANDLE_HALF = HANDLE_SIZE / 2;

/** 形状几何，一律 EMU（与 XML 的 a:off/a:ext 同口径）。 */
/** 旋转角（度，顺时针；XML 里是 60000 分之一度）。 */
export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 旋转角（度，顺时针；XML 里是 60000 分之一度）。 */
  rotation?: number;
}

/** 八个缩放点（PowerPoint 同款：四角 + 四边中点）。 */
export type CanvasCorner = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface CanvasHandle {
  corner: CanvasCorner;
  left: number;
  top: number;
  cursor: string;
}

export interface CanvasViewport {
  /** 页面在屏幕上的宽高（像素）。 */
  width: number;
  height: number;
  /** 显示像素 ÷ 渲染器像素。 */
  scale: number;
}

/** 屏幕像素 → EMU。 */
export function pxToEmu(px: number, scale: number): number {
  return scale > 0 ? (px / scale) * EMU_PER_PX : 0;
}

/** EMU → 屏幕像素。 */
export function emuToPx(emu: number, scale: number): number {
  return scale > 0 ? (emu / EMU_PER_PX) * scale : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * 四个角手柄的位置（显示像素，已减去半个手柄身位）。
 *
 * **夹在页面范围内**：形状被拖到页面外以后，真实的角会落在画布框外，手柄跟着跑出去就抓不住了
 * （真机实测："看得见点不着"，elementFromPoint 取不到它）。缩放用的是指针位移而不是手柄的绝对
 * 位置，所以把手柄挪到页边不影响缩放结果。
 */
export function handleSpots(box: CanvasBox, viewport: CanvasViewport): CanvasHandle[] {
  const half = HANDLE_HALF;
  const maxX = Math.max(half, viewport.width - half);
  const maxY = Math.max(half, viewport.height - half);
  const left = clamp(emuToPx(box.x, viewport.scale), half, maxX);
  const right = clamp(emuToPx(box.x + box.width, viewport.scale), half, maxX);
  const top = clamp(emuToPx(box.y, viewport.scale), half, maxY);
  const bottom = clamp(emuToPx(box.y + box.height, viewport.scale), half, maxY);
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  // **小形状只显四角**：形状小于 3 个手柄身位时，中边手柄会盖住形状中间——
  // 于是"从中心拖"抓到的是手柄，"移动"变成"拉扁"（真机/harness 实测：形状被压到最小高度）。
  // PowerPoint 也是这个规矩：框太小就只给四个角。
  const tooSmall = Math.min(right - left, bottom - top) < HANDLE_SIZE * 3;
  if (tooSmall) {
    return [
      { corner: "nw", left: left - half, top: top - half, cursor: "nwse-resize" },
      { corner: "ne", left: right - half, top: top - half, cursor: "nesw-resize" },
      { corner: "se", left: right - half, top: bottom - half, cursor: "nwse-resize" },
      { corner: "sw", left: left - half, top: bottom - half, cursor: "nesw-resize" },
    ];
  }
  return [
    { corner: "nw", left: left - half, top: top - half, cursor: "nwse-resize" },
    { corner: "n", left: midX - half, top: top - half, cursor: "ns-resize" },
    { corner: "ne", left: right - half, top: top - half, cursor: "nesw-resize" },
    { corner: "e", left: right - half, top: midY - half, cursor: "ew-resize" },
    { corner: "se", left: right - half, top: bottom - half, cursor: "nwse-resize" },
    { corner: "s", left: midX - half, top: bottom - half, cursor: "ns-resize" },
    { corner: "sw", left: left - half, top: bottom - half, cursor: "nesw-resize" },
    { corner: "w", left: left - half, top: midY - half, cursor: "ew-resize" },
  ];
}

/** 形状整块在页面外（画布上点不到它，只能靠页边手柄或检查器）。 */
export function isOffPage(box: CanvasBox, viewport: CanvasViewport): boolean {
  const left = emuToPx(box.x, viewport.scale);
  const top = emuToPx(box.y, viewport.scale);
  return (
    left > viewport.width ||
    left + emuToPx(box.width, viewport.scale) < 0 ||
    top > viewport.height ||
    top + emuToPx(box.height, viewport.scale) < 0
  );
}

/** 渲染器量到的每页元素几何（96dpi 像素）→ EMU 记账的 `{名字: 框}`。 */
export function measuredBoxesOf(
  elements: readonly {
    nodeName: string;
    bounds: { x: number; y: number; width: number; height: number };
  }[],
): Record<string, CanvasBox> {
  const boxes: Record<string, CanvasBox> = {};
  for (const element of elements) {
    boxes[element.nodeName] = {
      x: element.bounds.x * EMU_PER_PX,
      y: element.bounds.y * EMU_PER_PX,
      width: element.bounds.width * EMU_PER_PX,
      height: element.bounds.height * EMU_PER_PX,
    };
  }
  return boxes;
}

/** 拖动形状（移动/拉角/旋转）：`start` 是按下那一刻的几何。 */
export interface CanvasDragState {
  mode: "move" | "resize" | "rotate";
  corner: CanvasCorner;
  name: string;
  startX: number;
  startY: number;
  start: CanvasBox;
}

/**
 * 拖动中的几何（EMU）：往里/往北拉时左上角跟着走，但右下角不动；位移小于 1000 EMU 视为"只是点了一下"。
 * `dx`/`dy` 是**EMU 位移**（调用方用 `pxToEmu` 换算）。
 */
export function dragGeometry(state: CanvasDragState, dx: number, dy: number): CanvasBox {
  const base = state.start;
  if (state.mode === "move") {
    return {
      x: Math.round(base.x + dx),
      y: Math.round(base.y + dy),
      width: base.width,
      height: base.height,
    };
  }
  const corner = state.corner;
  const west = corner === "nw" || corner === "w" || corner === "sw";
  const east = corner === "ne" || corner === "e" || corner === "se";
  const north = corner === "nw" || corner === "n" || corner === "ne";
  const south = corner === "sw" || corner === "s" || corner === "se";
  // 边中点只动一个轴，另一轴保持原值
  const width = Math.max(MIN_EMU, west ? base.width - dx : east ? base.width + dx : base.width);
  const height = Math.max(
    MIN_EMU,
    north ? base.height - dy : south ? base.height + dy : base.height,
  );
  return {
    x: Math.round(west ? base.x + (base.width - width) : base.x),
    y: Math.round(north ? base.y + (base.height - height) : base.y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** 旋转手柄离顶边的距离（显示像素）。 */
export const ROTATE_OFFSET_PX = 26;

/** 旋转手柄的位置：顶边中点**上方**一段距离处（PowerPoint 同款）。 */
export function rotationHandleSpot(box: CanvasBox, viewport: CanvasViewport): CanvasHandle {
  const half = HANDLE_HALF;
  const maxX = Math.max(half, viewport.width - half);
  const maxY = Math.max(half, viewport.height - half);
  const top = clamp(emuToPx(box.y, viewport.scale), half, maxY);
  const left = clamp(emuToPx(box.x + box.width / 2, viewport.scale), half, maxX);
  return {
    corner: "nw",
    left: left - half,
    top: Math.max(0, top - ROTATE_OFFSET_PX) - half,
    cursor: "grab",
  };
}

/** 从形状中心指向 (px,py) 的角度（度，0 = 正上方，顺时针为正）。 */
export function angleFromCenter(
  box: CanvasBox,
  viewport: CanvasViewport,
  px: number,
  py: number,
): number {
  const centerX = emuToPx(box.x + box.width / 2, viewport.scale);
  const centerY = emuToPx(box.y + box.height / 2, viewport.scale);
  const degrees = (Math.atan2(px - centerX, centerY - py) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** 形状带旋转时，选框与手柄要一起转（度数）。 */
export function rotationOf(box: CanvasBox): number {
  return box.rotation ?? 0;
}

/** 表格的"边框带"宽度（显示像素）：靠边这么宽以内算"抓表格"，不算"选格子"。 */
export const TABLE_EDGE_PX = 6;

/**
 * 点是不是落在盒子的**边框带**里（纯几何，单位都是显示像素）。
 *
 * 为什么需要它：表格的框就是单元格的并集，早先"拖表格要抓边框"在表格上等于**没有可抓的地方**
 * （真机反馈"表格无法拖动"）。现在靠边 `band` 像素以内算边框 → 那颗点走"移动形状"。
 */
export function nearBoxEdge(
  point: { x: number; y: number },
  box: { left: number; top: number; right: number; bottom: number },
  band: number = TABLE_EDGE_PX,
): boolean {
  if (point.x < box.left || point.x > box.right || point.y < box.top || point.y > box.bottom) {
    return false;
  }
  return (
    point.x - box.left < band ||
    box.right - point.x < band ||
    point.y - box.top < band ||
    box.bottom - point.y < band
  );
}
