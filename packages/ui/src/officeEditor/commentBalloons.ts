/**
 * 批注气泡的**排版**（Word 的"批注框"）：贴右侧页边距、按锚点垂直位置对齐、重叠时往下让。
 *
 * 这里只做纯计算（可断言），DOM 渲染在 OfficeCommentBalloons。
 * 输入是每处批注锚点在**文档坐标**里的位置（`command.getGroupRectList(groupId)` 的矩形 × 缩放），
 * 输出是每张卡片在**页边列**里的 top（单位与输入一致）。
 */
export interface BalloonInput {
  id: string;
  /** 锚点顶部（文档坐标，已乘缩放）。没有锚点矩形时为 null。 */
  anchorTop: number | null;
  /** 这张卡片的高度（由内容估算，渲染前就要留位）。 */
  height: number;
}

export interface BalloonPosition {
  id: string;
  top: number;
  /** 是否与上一张卡片错开了（用于画引线时决定折点）。 */
  shifted: boolean;
}

/** 卡片间距（Word 的批注框之间也留一点空）。 */
const GAP = 8;

export function layoutBalloons(
  items: BalloonInput[],
  options: { minTop?: number } = {},
): BalloonPosition[] {
  const minTop = options.minTop ?? 0;
  const positions: BalloonPosition[] = [];
  let cursor = minTop;
  // 按锚点位置排：先出现的在上，没锚点的排在最后（Word 里这类显示在窗格底部）
  const ordered = [...items].sort((a, b) => {
    if (a.anchorTop === null && b.anchorTop === null) return 0;
    if (a.anchorTop === null) return 1;
    if (b.anchorTop === null) return -1;
    return a.anchorTop - b.anchorTop;
  });
  for (const item of ordered) {
    const desired = item.anchorTop === null ? cursor : Math.max(item.anchorTop, minTop);
    const top = Math.max(desired, cursor);
    positions.push({ id: item.id, top, shifted: top > desired + 0.5 });
    cursor = top + item.height + GAP;
  }
  return positions;
}

/** 引线：从正文锚点右侧连到卡片左侧（Word 画一条细线；这里给两段折线）。 */
export interface ConnectorPath {
  /** 文档坐标（x 相对纸张左边缘）。 */
  from: { x: number; y: number };
  to: { x: number; y: number };
  toX: number;
}

export function connectorFor(input: {
  anchorRight: number;
  anchorMiddleY: number;
  balloonLeft: number;
  balloonTop: number;
  balloonHeight: number;
}): ConnectorPath {
  const to = {
    x: input.balloonLeft,
    y: input.balloonTop + Math.min(input.balloonHeight / 2, 16),
  };
  return { from: { x: input.anchorRight, y: input.anchorMiddleY }, to, toX: to.x };
}
