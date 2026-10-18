/**
 * PPT 的**数据层断言**：形状（几何/格式/层级/复制删除/新建文本框）与
 * 幻灯片（新建/复制/删除/调顺序），外加"只动了该动的部件"这条保真底线。
 *
 * 抽出来的原因：仓库规矩单文件 ≤400 行；这些是"改字节"的活，与界面级那批分开更好读。
 */
export async function runPptxEditCases({ page, check }) {
  // ⑥b 形状层：几何 / 格式 / 层级 / 复制 / 删除 / 新建文本框（都只改目标部件）
  const shapes = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    const deck = await window.__pptx.readDeck(bytes);
    const slidePart = deck.slides[0].partName;
    const xml = deck.sourceXml.get(slidePart);
    const listed = window.__pptx.readShapes(xml);
    const moved = window.__pptx.setShapeBounds(xml, listed[0].name, {
      x: 1111111,
      y: 222222,
      width: 3333333,
      height: 444444,
    });
    const formatted = window.__pptx.setShapeTextFormat(moved, listed[0].name, {
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      size: 36,
      color: "#FF0000",
      font: "黑体",
    });
    const aligned = window.__pptx.setShapeParagraphFormat(formatted, listed[0].name, {
      align: "center",
      bullet: true,
    });
    const up = window.__pptx.moveShapeZ(aligned, listed[1].name, "up");
    const duplicated = window.__pptx.duplicateShape(up, listed[0].name);
    const deleted = window.__pptx.deleteShape(duplicated.xml, listed[1].name);
    const added = window.__pptx.insertTextBox(deleted, {
      x: 100,
      y: 200,
      width: 3000000,
      height: 800000,
      text: "新文本框",
    });
    const finalShapes = window.__pptx.readShapes(added.xml);
    return {
      listed: listed.map((shape) => ({
        name: shape.name,
        explicit: shape.bounds.explicit,
        width: shape.bounds.width,
      })),
      movedBounds: window.__pptx.readShapes(moved).find((shape) => shape.name === listed[0].name)
        ?.bounds,
      formatAttrs:
        /b="1"/.test(formatted) &&
        /i="1"/.test(formatted) &&
        /u="sng"/.test(formatted) &&
        /strike="sngStrike"/.test(formatted),
      sizeAndColor:
        /sz="3600"/.test(formatted) && /FF0000/.test(formatted) && /黑体/.test(formatted),
      rPrSample: (formatted.match(/<a:rPr[^>]*>[\s\S]{0,120}?<\/a:rPr>/) ?? [""])[0].slice(0, 200),
      aligned: /algn="ctr"/.test(aligned) && /buChar/.test(aligned),
      zOrder: window.__pptx.readShapes(up).findIndex((shape) => shape.name === listed[1].name),
      duplicateName: duplicated.name,
      finalNames: finalShapes.map((shape) => shape.name),
      addedTextBox: finalShapes.some((shape) => shape.name === added.name),
    };
  });
  check(
    shapes.listed.length === 2,
    `形状能列出来（${shapes.listed.map((s) => s.name).join("、")}）`,
  );
  check(
    shapes.movedBounds?.x === 1111111 && shapes.movedBounds?.width === 3333333,
    `几何改动落到 XML（${JSON.stringify(shapes.movedBounds)}）`,
  );
  check(
    shapes.formatAttrs && shapes.sizeAndColor,
    `文字格式（粗/斜/下划线/删除线/字号/颜色/字体）落到 XML｜rPr=${shapes.rPrSample}`,
  );
  check(shapes.aligned, "段落对齐与项目符号落到 XML");
  // "上移"= 往文档后面挪（后面的画在上面），所以两形状时它应该变成最后一个
  check(
    shapes.zOrder === 1,
    `层级能上移（${shapes.listed[1].name} 现在在 ${shapes.zOrder + 1}/${shapes.finalNames.length}）`,
  );
  check(
    typeof shapes.duplicateName === "string" && shapes.duplicateName.includes("副本"),
    `复制形状（新名字 ${shapes.duplicateName}）`,
  );
  check(
    !shapes.finalNames.includes(shapes.listed[1].name) && shapes.addedTextBox,
    `删除与新建文本框都生效（现在：${shapes.finalNames.join("、")}）`,
  );

  // ⑥c 幻灯片级：新建 / 复制 / 删除 / 调顺序（只动 presentation.xml、rels、Content_Types 与新部件）
  const slideOps = await page.evaluate(async () => {
    // **每个消费者拿自己的副本**：JSZip 会消费传入的 buffer（实测），共享一份 buffer 会在
    // 某一环突然报"读不到数据"。这一步一步都显式切片，行为可预测。
    const source = (await window.__pptx.fixture()).bytes.slice(0);
    const partsBefore = await window.__pptx.parts(source.slice(0));
    const before = await window.__pptx.readSlideOrder(source.slice(0));
    const added = await window.__pptx.addSlide({ source: source.slice(0) });
    const afterAdd = await window.__pptx.readSlideOrder(added.slice(0));
    const duplicated = await window.__pptx.duplicateSlide({
      source: added.slice(0),
      partName: afterAdd.entries[0].partName,
    });
    const afterDuplicate = await window.__pptx.readSlideOrder(duplicated.slice(0));
    const moved = await window.__pptx.moveSlide({
      source: duplicated.slice(0),
      partName: afterDuplicate.entries[0].partName,
      to: 2,
    });
    const afterMove = await window.__pptx.readSlideOrder(moved.slice(0));
    const deleted = await window.__pptx.deleteSlide({
      source: moved.slice(0),
      partName: afterMove.entries[0].partName,
    });
    const afterDelete = await window.__pptx.readSlideOrder(deleted.slice(0));
    const partsAfter = await window.__pptx.parts(deleted.slice(0));
    const changed = Object.keys(partsBefore).filter(
      (name) => partsBefore[name] !== partsAfter[name],
    );
    const rendered = await window.__pptx.render(deleted.slice(0));
    const validation = await window.__pptx.validate(deleted.slice(0), source.slice(0), {
      editedSlides: [],
    });
    return {
      count: [
        before.entries.length,
        afterAdd.entries.length,
        afterDuplicate.entries.length,
        afterDelete.entries.length,
      ],
      movedOrder: afterMove.entries.map((entry) => entry.partName),
      changed,
      renderedSlides: rendered.slides,
      validation,
    };
  });
  check(
    JSON.stringify(slideOps.count) === JSON.stringify([2, 3, 4, 3]),
    `新建/复制/删除幻灯片（页数变化 ${slideOps.count.join(" → ")}）`,
  );
  check(
    slideOps.movedOrder[2]?.endsWith("slide1.xml"),
    `调顺序落到 presentation.xml（顺序：${slideOps.movedOrder.join("、")}）`,
  );
  check(
    slideOps.changed.every((name) => /presentation\.xml|\[Content_Types\]|_rels/.test(name)),
    `只动了该动的部件（变化：${slideOps.changed.join("、") || "无"}）`,
  );
  check(
    slideOps.renderedSlides === 3,
    `幻灯片操作后的产物渲染器能打开（${slideOps.renderedSlides} 页）`,
  );
}
