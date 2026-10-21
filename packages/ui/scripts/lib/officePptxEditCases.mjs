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

  // ⑨ 插图片 → 删除：XML、形状列表、**渲染出来的元素**三处都要没了
  //   （用户反馈：删除后图片还在画面上、但已经选不中——典型的"列表变了、预览没重建"）
  const pictureRoundTrip = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    const deck = await window.__pptx.readDeck(bytes);
    const part = deck.slides[0].partName;
    const dataUri = await window.__pptx.sampleImageDataUri();
    const inserted = await window.__pptx.insertPicture({
      source: bytes,
      partName: part,
      dataUri,
      pageWidth: 9144000,
      pageHeight: 6858000,
    });
    const slideXml =
      (await (await window.__pptx.rawZip(inserted.bytes)).file(part)?.async("string")) ?? "";
    const shape = window.__pptx.readShapes(slideXml).find((item) => item.kind === "pic");
    if (!shape) return { inserted: false };
    const deletedXml = window.__pptx.deleteShape(slideXml, shape.name);
    // 删掉之后：这一页 XML 里不该再有 p:pic
    const stillHasPic = /<p:pic[ >]/.test(deletedXml);
    // 用"编辑过一个部件"的方式写出新包（与编辑器保存同一路径），再看渲染器认不认
    // 关键：**基线与 source 必须一致**（source 已经是"带图"的那一版，基线也得是带图的）。
    // 反例（早先这里就是）：基线用原始（无图）、source 用带图 → 删除后 XML 正好回到基线内容，
    // 差分认为"没变"而跳过写回，zip 里就留住了那张图（真机症状：删了图片画布上还在）。
    const withPictureXml =
      (await (await window.__pptx.rawZip(inserted.bytes)).file(part)?.async("string")) ?? "";
    const written = await window.__pptx.write({
      source: inserted.bytes,
      baseline: new Map([[part, withPictureXml]]),
      current: new Map([[part, deletedXml]]),
    });
    const renderAfter = await window.__pptx.render(written.bytes);
    // 关键：**写出来的字节**里这一页还有没有 p:pic（早先只查了 XML 字符串，漏了包）
    const writtenZip = await window.__pptx.rawZip(written.bytes);
    const writtenSlide = (await writtenZip.file(part)?.async("string")) ?? "";
    return {
      inserted: true,
      name: shape.name,
      stillHasPic,
      shapesAfter: window.__pptx.readShapes(deletedXml).map((item) => `${item.name}:${item.kind}`),
      renderedAfter: renderAfter,
      picInWrittenBytes: /<p:pic[ >]/.test(writtenSlide),
      writtenSlideLength: writtenSlide.length,
    };
  });
  check(
    pictureRoundTrip.inserted && pictureRoundTrip.picInWrittenBytes === false,
    `写出来的字节里也没有 p:pic（这一页 ${pictureRoundTrip.writtenSlideLength} 字节）`,
  );
  check(
    pictureRoundTrip.inserted && !pictureRoundTrip.stillHasPic,
    `删除形状后这一页 XML 里没有 p:pic 了（${pictureRoundTrip.shapesAfter?.join("、") ?? "?"}）`,
  );

  // ⑩ 插表格：p:graphicFrame + a:tbl（行列数、每个单元格有空 txBody、几何在 p:xfrm）
  const tableInsert = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    const deck = await window.__pptx.readDeck(bytes);
    const part = deck.slides[1].partName;
    const result = window.__pptx.insertTable(deck.sourceXml.get(part), {
      rows: 3,
      cols: 4,
      pageWidth: 9144000,
      pageHeight: 6858000,
    });
    const document2 = new DOMParser().parseFromString(result.xml, "application/xml");
    const ns = "http://schemas.openxmlformats.org/drawingml/2006/main";
    const frame = document2.getElementsByTagNameNS(
      "http://schemas.openxmlformats.org/presentationml/2006/main",
      "graphicFrame",
    )[0];
    const shapes = window.__pptx.readShapes(result.xml);
    return {
      name: result.name,
      tail: frame ? (frame.lastElementChild?.nodeName ?? "") : "",
      gridCols: frame?.getElementsByTagNameNS(ns, "gridCol").length ?? 0,
      rows: frame?.getElementsByTagNameNS(ns, "tr").length ?? 0,
      cells: frame?.getElementsByTagNameNS(ns, "tc").length ?? 0,
      bodies: frame?.getElementsByTagNameNS(ns, "txBody").length ?? 0,
      kinds: shapes.map((item) => `${item.name}:${item.kind}`),
      bounds: shapes.find((item) => item.name === result.name)?.bounds ?? null,
      blocks: (
        await window.__pptx.readDeck(
          await window.__pptx
            .write({
              source: bytes,
              baseline: new Map([[part, deck.sourceXml.get(part)]]),
              current: new Map([[part, result.xml]]),
            })
            .then((written) => written.bytes),
        )
      ).slides[1].blocks.length,
    };
  });
  check(
    tableInsert.gridCols === 4 && tableInsert.rows === 3 && tableInsert.cells === 12,
    `插表格：4 列 3 行 12 个单元格（${tableInsert.gridCols}/${tableInsert.rows}/${tableInsert.cells}）`,
  );
  check(
    tableInsert.bodies === 12 && tableInsert.tail.toUpperCase().endsWith("GRAPHIC"),
    `每个单元格都有空的 txBody，且 p:graphicFrame 末子元素是 a:graphic（${tableInsert.bodies} 个 / ${tableInsert.tail}）`,
  );
  check(
    tableInsert.kinds.some((item) => item.endsWith(":graphicFrame")) &&
      tableInsert.bounds?.explicit === true,
    `形状层认得这个表格且几何是显式的（${tableInsert.kinds.join("、")}）`,
  );
  check(
    // 这一页本来还有一个文本框：1 + 12 个单元格 = 13 块
    tableInsert.blocks === 13,
    `写回后这一页读得出 12 个单元格 + 原文本框共 13 块（可继续逐格编辑）（${tableInsert.blocks}）`,
  );

  // ⑪ 单元格级读写：按"表格名 + 行列"定位文本块；增删行列时 p:xfrm 的尺寸跟着变
  const cellOps = await page.evaluate(() => {
    const ns = "http://schemas.openxmlformats.org/drawingml/2006/main";
    const size = (xml, name) => window.__pptx.tableSizeOf(xml, name);
    const ext = (xml, name) => {
      const document = new DOMParser().parseFromString(xml, "application/xml");
      const frames = [
        ...document.getElementsByTagNameNS(
          "http://schemas.openxmlformats.org/presentationml/2006/main",
          "graphicFrame",
        ),
      ];
      const frame = frames.find(
        (node) =>
          node
            .getElementsByTagNameNS(
              "http://schemas.openxmlformats.org/presentationml/2006/main",
              "cNvPr",
            )[0]
            ?.getAttribute("name") === name,
      );
      const e = frame?.getElementsByTagNameNS(ns, "ext")[0];
      return e ? { cx: Number(e.getAttribute("cx")), cy: Number(e.getAttribute("cy")) } : null;
    };
    const build = () =>
      window.__pptx.insertTable(
        '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="' +
          ns +
          '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sld>',
        { rows: 2, cols: 2, pageWidth: 9144000, pageHeight: 6858000 },
      );
    const start = build();
    const name = start.name;
    const before = ext(start.xml, name);
    const insertedRow = window.__pptx.applyTableStructureEdit(start.xml, name, 0, 0, {
      kind: "insertRowBelow",
    });
    const insertedCol = window.__pptx.applyTableStructureEdit(start.xml, name, 0, 0, {
      kind: "insertColumnRight",
    });
    const deletedRow = window.__pptx.applyTableStructureEdit(start.xml, name, 0, 0, {
      kind: "deleteRow",
    });
    const deletedCol = window.__pptx.applyTableStructureEdit(start.xml, name, 0, 0, {
      kind: "deleteColumn",
    });
    const lastRow = window.__pptx.applyTableStructureEdit(
      window.__pptx.applyTableStructureEdit(start.xml, name, 0, 0, { kind: "deleteRow" }),
      name,
      0,
      0,
      { kind: "deleteRow" },
    );
    const lastCol = window.__pptx.applyTableStructureEdit(
      window.__pptx.applyTableStructureEdit(start.xml, name, 0, 0, { kind: "deleteColumn" }),
      name,
      0,
      0,
      { kind: "deleteColumn" },
    );
    // 单元格 → 整页文本块序号：第 2 行第 2 列（0 基）应是最后一个 txBody
    const blockIndexOfLast = window.__pptx.cellBlockIndexOf(start.xml, name, 1, 1);
    const total = new DOMParser()
      .parseFromString(start.xml, "application/xml")
      .getElementsByTagNameNS("*", "txBody").length;
    return {
      name,
      isTable: window.__pptx.isTableShape(start.xml, name),
      base: size(start.xml, name),
      insertedRow: size(insertedRow, name),
      insertedCol: size(insertedCol, name),
      deletedRow: size(deletedRow, name),
      deletedCol: size(deletedCol, name),
      lastRow: size(lastRow, name),
      lastCol: size(lastCol, name),
      growRow: ext(insertedRow, name),
      growCol: ext(insertedCol, name),
      before,
      blockIndexOfLast,
      total,
    };
  });
  check(
    cellOps.isTable && cellOps.base?.rows === 2 && cellOps.base?.cols === 2,
    `认得表格并读出行列（${cellOps.name} = ${cellOps.base?.rows}×${cellOps.base?.cols}）`,
  );
  check(
    cellOps.insertedRow?.rows === 3 &&
      cellOps.insertedCol?.cols === 3 &&
      cellOps.deletedRow?.rows === 1 &&
      cellOps.deletedCol?.cols === 1,
    `增删行列都对（加行 ${cellOps.insertedRow?.rows}、加列 ${cellOps.insertedCol?.cols}、删行 ${cellOps.deletedRow?.rows}、删列 ${cellOps.deletedCol?.cols}）`,
  );
  check(
    cellOps.lastRow?.rows === 1 && cellOps.lastCol?.cols === 1,
    `删到只剩 1 行/1 列就不再删（${cellOps.lastRow?.rows}×${cellOps.lastCol?.cols}）`,
  );
  check(
    cellOps.growRow?.cy > cellOps.before?.cy && cellOps.growCol?.cx > cellOps.before?.cx,
    `加一行/一列时 p:xfrm 的尺寸跟着长（${cellOps.before?.cx}×${cellOps.before?.cy} → 行 ${cellOps.growRow?.cx}×${cellOps.growRow?.cy}、列 ${cellOps.growCol?.cx}×${cellOps.growCol?.cy}）`,
  );
  check(
    cellOps.blockIndexOfLast === cellOps.total - 1,
    `"第 2 行第 2 列"定位到最后一个文本块（序号 ${cellOps.blockIndexOfLast} / 共 ${cellOps.total}）`,
  );

  // ⑫ 表格的"内容面"：合并/拆分、底纹、边框、样式开关（都按 PowerPoint 写出来的形态）
  const tableContent = await page.evaluate(() => {
    const ns = "http://schemas.openxmlformats.org/drawingml/2006/main";
    const pns = "http://schemas.openxmlformats.org/presentationml/2006/main";
    const start = window.__pptx.insertTable(
      '<?xml version="1.0"?><p:sld xmlns:p="' +
        pns +
        '" xmlns:a="' +
        ns +
        '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sld>',
      { rows: 2, cols: 3, pageWidth: 9144000, pageHeight: 6858000 },
    );
    const name = start.name;
    const doc = (xml) => new DOMParser().parseFromString(xml, "application/xml");
    const cells = (xml) => {
      const frame = [...doc(xml).getElementsByTagNameNS(pns, "graphicFrame")].find(
        (node) => node.getElementsByTagNameNS(pns, "cNvPr")[0]?.getAttribute("name") === name,
      );
      return [...(frame?.getElementsByTagNameNS(ns, "tr") ?? [])].map((row) =>
        [...row.children]
          .filter((child) => child.localName === "tc")
          .map((cell) => ({
            gridSpan: cell.getAttribute("gridSpan"),
            rowSpan: cell.getAttribute("rowSpan"),
            hMerge: cell.getAttribute("hMerge"),
            vMerge: cell.getAttribute("vMerge"),
            fill: cell.getElementsByTagNameNS(ns, "srgbClr")[0]?.getAttribute("val") ?? null,
            borders: ["lnL", "lnR", "lnT", "lnB"].every(
              (line) => cell.getElementsByTagNameNS(ns, line).length > 0,
            ),
          })),
      );
    };
    const mergedRight = window.__pptx.mergeCell(start.xml, name, 0, 0, "right");
    const mergedDown = window.__pptx.mergeCell(start.xml, name, 0, 0, "down");
    const split = window.__pptx.splitCell(mergedRight, name, 0, 0);
    const filled = window.__pptx.setCellFill(start.xml, name, 1, 2, "D93025");
    const bordered = window.__pptx.setCellBorder(start.xml, name, 0, 1, {
      on: true,
      color: "1A73E8",
    });
    const firstRowOff = window.__pptx.setTableOptions(start.xml, name, { firstRow: false });
    return {
      base: window.__pptx.tableSizeOf(start.xml, name),
      mergedRightCell: cells(mergedRight)[0][0],
      mergedRightSibling: cells(mergedRight)[0][1],
      mergedDownCell: cells(mergedDown)[0][0],
      mergedDownBelow: cells(mergedDown)[1][0],
      afterSplit: cells(split)[0].slice(0, 3),
      fill: cells(filled)[1][2].fill,
      border: cells(bordered)[0][1].borders,
      optionsBefore: window.__pptx.tableOptionsOf(start.xml, name),
      optionsAfter: window.__pptx.tableOptionsOf(firstRowOff, name),
    };
  });
  check(
    tableContent.mergedRightCell?.gridSpan === "2" &&
      tableContent.mergedRightSibling?.hMerge === "1",
    `向右合并：本格 gridSpan=2、右邻 hMerge=1（${JSON.stringify(tableContent.mergedRightCell)}）`,
  );
  check(
    tableContent.mergedDownCell?.rowSpan === "2" && tableContent.mergedDownBelow?.vMerge === "1",
    `向下合并：本格 rowSpan=2、下邻 vMerge=1（${JSON.stringify(tableContent.mergedDownBelow)}）`,
  );
  check(
    tableContent.afterSplit?.every(
      (cell) => !cell.gridSpan && !cell.rowSpan && !cell.hMerge && !cell.vMerge,
    ),
    `拆分把合并标记全撤掉（${JSON.stringify(tableContent.afterSplit)}）`,
  );
  check(
    tableContent.fill === "D93025" && tableContent.border === true,
    `底纹与边框落到单元格（底纹 ${tableContent.fill}／四边边框 ${tableContent.border}）`,
  );
  check(
    tableContent.optionsBefore?.firstRow === true && tableContent.optionsAfter?.firstRow === false,
    `表格样式开关（首行突出 ${tableContent.optionsBefore?.firstRow} → ${tableContent.optionsAfter?.firstRow}）`,
  );

  // ⑭ 任意矩形合并（选一片并成一格）+ 格内垂直/水平对齐
  const rectRun = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    const deck = await window.__pptx.readDeck(bytes);
    const part = deck.slides[0].partName;
    const xml0 = deck.sourceXml.get(part) ?? "";
    // fixture 的表格是 1×1：先长成 2×2（下面加一行、右边加一列），再并这一片
    const grownRow = window.__pptx.applyTableStructureEdit(xml0, "表格 1", 0, 0, {
      kind: "insertRowBelow",
    });
    const grown = window.__pptx.applyTableStructureEdit(grownRow, "表格 1", 0, 0, {
      kind: "insertColumnRight",
    });
    const merged = window.__pptx.mergeCellRange(
      grown,
      "表格 1",
      { row: 0, col: 0 },
      { row: 1, col: 1 },
    );
    // 锚点标签要按**带属性的开标签**取（合并后它是 `<a:tc gridSpan="2" rowSpan="2">`）
    const anchorTag = /<a:tc[^>]*>/.exec(merged)?.[0] ?? "";
    // 只数表格里的文字（整页还有标题那几处 a:t）
    const tableText = merged.slice(merged.indexOf("<a:tbl>"));
    const textCount = (tableText.match(/<a:t>/g) ?? []).length;
    const anchored = window.__pptx.setCellAnchor(merged, "表格 1", 0, 0, "middle");
    const aligned = window.__pptx.setCellAlign(anchored, "表格 1", 0, 0, "center");
    const format = window.__pptx.cellFormatOf(aligned, "表格 1", 0, 0);
    const split = window.__pptx.splitCell(aligned, "表格 1", 0, 0);
    // 写回 + 校验 + 渲染：合并/对齐之后这份 deck 还得是合法的
    const current = new Map(deck.sourceXml);
    current.set(part, aligned);
    const written = await window.__pptx.write({ source: bytes, baseline: deck.sourceXml, current });
    const validation = await window.__pptx.validate(written.bytes, bytes, {
      editedSlides: written.changedSlides,
    });
    const rendered = await window.__pptx.render(written.bytes);
    const reread = await window.__pptx.readDeck(written.bytes);
    return {
      size: window.__pptx.tableSizeOf(grown, "表格 1"),
      anchorSpan: [/gridSpan="2"/.test(anchorTag), /rowSpan="2"/.test(anchorTag)],
      covered: [/hMerge="1"/.test(merged), /vMerge="1"/.test(merged)],
      // 被并掉的三格文字要清掉：整张表里只剩锚点那一处文字
      textCount,
      format,
      alignProp: /<a:pPr algn="ctr"\/>/.test(aligned),
      splitBack: !/gridSpan|rowSpan|hMerge|vMerge/.test(split),
      mergeSurvivedRender: rendered.slides === 2,
      mergedText: reread.slides[0].blocks[1]?.lines?.join("|") ?? null,
      validation: { ok: validation.ok, issues: validation.issues.map((issue) => issue.message) },
    };
  });
  check(
    rectRun.size?.rows === 2 && rectRun.size?.cols === 2,
    `先把表格长成 2×2 再并（${rectRun.size?.rows}×${rectRun.size?.cols}）`,
  );
  check(
    rectRun.anchorSpan[0] && rectRun.anchorSpan[1] && rectRun.covered[0] && rectRun.covered[1],
    `任意矩形合并写成锚点 gridSpan/rowSpan + 其余格 hMerge/vMerge（2×2 一片）`,
  );
  check(
    rectRun.textCount === 1,
    `被并掉的格文字清掉、只留左上角（整张表里 <a:t> 数量 ${rectRun.textCount}）`,
  );
  check(
    rectRun.format?.anchor === "middle" && rectRun.format?.align === "center" && rectRun.alignProp,
    `垂直对齐写 a:tcPr@anchor、水平对齐写段落 a:pPr@algn（读回 ${JSON.stringify(rectRun.format)}）`,
  );
  check(rectRun.splitBack, "拆分把整片合并标记一次性撤掉（gridSpan/rowSpan/hMerge/vMerge 都没了）");
  check(
    rectRun.validation.ok &&
      rectRun.mergeSurvivedRender &&
      rectRun.mergedText?.includes("单元格文字"),
    `合并后的这一页写得回、校验过、渲染器仍认得（${rectRun.mergedText}）`,
  );

  // ⑭b 网格线：插入的表自带四边线；整表"套用/去掉网格"是开关（用户："表格没有边框？"）
  const gridRun = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    const deck = await window.__pptx.readDeck(bytes);
    const part = deck.slides[0].partName;
    const xml0 = deck.sourceXml.get(part) ?? "";
    const inserted = window.__pptx.insertTable(xml0, {
      rows: 2,
      cols: 2,
      pageWidth: 9144000,
      pageHeight: 6858000,
    });
    const name = inserted.name;
    const cellSides = ["lnL", "lnR", "lnT", "lnB"];
    // 只数表格里的线：序列化后开标签可能带命名空间（`<a:tbl xmlns:…>`），所以用正则找起点
    const countLines = (xml) => {
      // 用**最后一张**表：这一页原本就有一张 fixture 的表（它没有线），插进来的在它后面
      const start = xml.lastIndexOf("<a:tbl");
      const end = xml.indexOf("</a:tbl>", start);
      const table = start < 0 || end < 0 ? "" : xml.slice(start, end);
      return Object.fromEntries(
        cellSides.map((side) => [
          side,
          (table.match(new RegExp(`<a:${side}[ >]`, "g")) ?? []).length,
        ]),
      );
    };
    const insertedLines = countLines(inserted.xml);
    const on = window.__pptx.tableGridOn(inserted.xml, name);
    const off = window.__pptx.setTableGrid(inserted.xml, name, false);
    const offLines = countLines(off);
    const backOn = window.__pptx.setTableGrid(off, name, true);
    // 写回 + 渲染：带网格的表在**画布上真的看得见线**（下面界面断言用挂载后的计算样式再验一次）
    const current = new Map(deck.sourceXml);
    current.set(part, backOn);
    const written = await window.__pptx.write({ source: bytes, baseline: deck.sourceXml, current });
    const validation = await window.__pptx.validate(written.bytes, bytes, {
      editedSlides: written.changedSlides,
    });
    return {
      name,
      insertedLines,
      on,
      offLines,
      reOn: window.__pptx.tableGridOn(backOn, name),
      cells: 4,
      validation: validation.ok,
      rendered: (await window.__pptx.render(written.bytes)).slides,
    };
  });
  check(
    gridRun.insertedLines.lnL === 4 &&
      gridRun.insertedLines.lnT === 4 &&
      gridRun.on &&
      gridRun.cells === 4,
    `插入的表格自带网格线（4 格 × 四边：lnL ${gridRun.insertedLines.lnL}／lnT ${gridRun.insertedLines.lnT}）`,
  );
  check(
    !gridRun.offLines.lnL && gridRun.reOn && gridRun.validation && gridRun.rendered === 2,
    `整表网格是开关（去掉后 0 条线，再套回 ${gridRun.reOn}；产物仍合法、渲染 ${gridRun.rendered} 页）`,
  );

  // ⑬ 讲稿备注：读已有的、改它、给没有备注的页新建一个（部件 + rel + Content_Types）
  const notesRun = await page.evaluate(async () => {
    const { bytes } = await window.__pptx.fixture();
    const deck = await window.__pptx.readDeck(bytes);
    const slide1 = deck.slides[0].partName;
    const slide2 = deck.slides[1].partName;
    const part1 = await window.__pptx.notesPartOf(bytes, slide1);
    const part2 = await window.__pptx.notesPartOf(bytes, slide2);
    const xml1 = part1
      ? ((await (await window.__pptx.rawZip(bytes)).file(part1)?.async("string")) ?? "")
      : "";
    const bodyIndex = xml1 ? window.__pptx.notesBodyIndex(xml1) : null;
    const patched =
      bodyIndex === null ? null : window.__pptx.patch(xml1, bodyIndex, ["改过的讲稿"]);
    const created = await window.__pptx.addNotesSlide(bytes.slice(0), slide2, part1);
    const zipAfter = await window.__pptx.rawZip(created.bytes);
    const relsName = `ppt/slides/_rels/${slide2.split("/").pop()}.rels`;
    const rels = (await zipAfter.file(relsName)?.async("string")) ?? "";
    const contentTypes = (await zipAfter.file("[Content_Types].xml")?.async("string")) ?? "";
    const rendered = await window.__pptx.render(created.bytes);
    return {
      part1,
      part2,
      text1: xml1 ? window.__pptx.readNotesText(xml1) : null,
      bodyIndex,
      afterPatch: patched ? window.__pptx.readNotesText(patched) : null,
      slidesStillReadable: (await window.__pptx.readDeck(created.bytes)).slides.length,
      newPartName: created.partName,
      partExists: Boolean(zipAfter.file(created.partName)),
      relAdded: rels.includes("notesSlide"),
      contentType: contentTypes.includes("/ppt/notesSlides/"),
      renderedSlides: rendered.slides,
    };
  });
  check(
    notesRun.part1 === "ppt/notesSlides/notesSlide1.xml" && notesRun.part2 === null,
    `按"这一页的 rels"找到备注部件（第 1 页 ${notesRun.part1}、第 2 页无）`,
  );
  check(
    notesRun.text1?.join("|") === "讲稿备注" && notesRun.bodyIndex !== null,
    `读得出备注正文并定位到它的 txBody（${JSON.stringify(notesRun.text1)}，序号 ${notesRun.bodyIndex}）`,
  );
  check(
    notesRun.afterPatch?.join("|") === "改过的讲稿",
    `改备注只动那一个 txBody（${JSON.stringify(notesRun.afterPatch)}）`,
  );
  check(
    notesRun.partExists && notesRun.relAdded && notesRun.contentType,
    `给没有备注的页新建备注部件（${notesRun.newPartName}）并补 rel 与 Content_Types`,
  );
  check(
    notesRun.slidesStillReadable === 2 && notesRun.renderedSlides === 2,
    `加了备注部件之后这份 deck 仍然读得开、渲染器也认（${notesRun.renderedSlides} 页）`,
  );
}
