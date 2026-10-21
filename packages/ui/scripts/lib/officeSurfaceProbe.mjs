/**
 * 布局检查里的**纸面探针**：渲染真实的 OfficeEditorSurface，断言
 * ① 有批注时纸张仍然居中（批注栏挂在右侧页边距上，不能把纸张推左）；
 * ② 批注框按锚点高度摆了两张。
 * 抽出来的原因：检查脚本要守 400 行上限。
 */
export const SURFACE_PROBE_SOURCE = `
const surfaceComments = [
  { index: 1, id: "c1", author: "审阅者", date: "2026-10-14T10:05:00Z", text: "请确认该段表述。", paragraph: 6, anchorText: "第 7 段" },
  { index: 2, id: "c2", author: "审阅者", date: "2026-10-14T10:06:00Z", text: "第二条批注。", paragraph: 13, anchorText: "第 14 段" },
];

function SurfaceProbe() {
  const hostRef = React.useRef(null);
  const scrollRef = React.useRef(null);
  const anchors = new Map(surfaceComments.map((comment, index) => [comment.id, {
    id: comment.id,
    anchor: { x: 120, y: 400 + index * 500, width: 200, height: 20 },
    height: 52,
  }]));
  return (
    <div id="surface-probe" style={{ width: 1200, height: 600, display: "flex", flexDirection: "column" }}>
      <OfficeEditorSurface
        hostRef={hostRef}
        scrollRef={scrollRef}
        pageWidth={794}
        comments={surfaceComments}
        anchors={anchors}
        activeComment={-1}
        onPickComment={() => {}}
        onDeleteComment={() => {}}
      />
    </div>
  );
}
`;

/** 断言纸面居中与批注框数量；返回失败信息数组。 */
export async function checkSurfaceCentering(page) {
  const failures = [];
  const centering = await page.evaluate(() => {
    const scroll = document.querySelector("#surface-probe #office-editor-scroll");
    const host = document.querySelector("#surface-probe #office-editor-host");
    if (!scroll || !host) return null;
    const scrollRect = scroll.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      leftGap: Math.round(hostRect.left - scrollRect.left),
      rightGap: Math.round(scrollRect.right - hostRect.right),
      balloons: document.querySelectorAll("[data-office-comment-balloon]").length,
    };
  });
  console.log(
    `纸张居中：左 ${centering?.leftGap}px / 右 ${centering?.rightGap}px · 批注框 ${centering?.balloons} 个`,
  );
  if (!centering) failures.push("纸面探针没有渲染出来");
  else {
    if (centering.balloons !== 2) failures.push(`批注框数量不对（${centering.balloons}）`);
    if (Math.abs(centering.leftGap - centering.rightGap) > 2)
      failures.push(
        `有批注时纸张没有居中（左 ${centering.leftGap} / 右 ${centering.rightGap}）——会被批注栏挤偏`,
      );
  }
  return failures;
}
