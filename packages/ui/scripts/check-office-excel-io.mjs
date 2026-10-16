/**
 * xlsx 适配层的**保真回归**：读进来 → 改一格 → 写回去，验证
 *   ① 改的那格真的落了盘；
 *   ② **没动的东西原样还在**（批注/超链接/数据验证/数字格式/合并/列宽行高/冻结/隐藏表/另一张表）；
 *   ③ 没改动时一次盘都不写（changedCells=0）；
 *   ④ 产物校验能认出"少了表/丢了内容"的坏产物；
 *   ⑤ 护栏认出带图表的工作簿（命中就只给只读）。
 *
 * 为什么这么较真：Excel 的写回是**在原字节上做差分**，一旦配对或映射错了，
 * 用户看到的是"我改了一个数字，结果批注和另一张表没了"。这些断言就是那条底线。
 *
 * 用法：node packages/ui/scripts/check-office-excel-io.mjs
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCEL_PAGE, bundleExcelEntry } from "./lib/officeExcelPage.mjs";
import { startOfficeHarness } from "./lib/officeEditorHarness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

async function main() {
  const started = Date.now();
  const stage = (name) => console.log(`… ${name}（${Math.round((Date.now() - started) / 1000)}s）`);
  stage("打产物");
  const harness = await startOfficeHarness({
    prefix: "office-excel-io-",
    pages: { "index.html": EXCEL_PAGE },
    // 真样本（给人手点的那两个）也要过一遍同样的路径：用户第一次打开的很可能就是它们
    copies: {
      [join(repoRoot, "packages/ui/test/fixtures/office-sample.xlsx")]: "office-sample.xlsx",
    },
    prepareDir: (dir) =>
      bundleExcelEntry(dir, {
        repoRoot,
        editorDir,
        modules: ["xlsxWorkbook.ts", "xlsxValidate.ts", "xlsxPreflight.ts"],
        sampleSheets: [],
      }),
    viewport: { width: 900, height: 700 },
  });
  stage("页面就绪");
  const page = harness.page;

  const failures = [];
  const check = (ok, message) => {
    if (ok) console.log(`ok   ${message}`);
    else {
      console.log(`FAIL ${message}`);
      failures.push(message);
    }
  };

  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });

  // ① 读：值/公式/格式/合并/列宽行高/隐藏表都要读得出来
  const roundTrip = await page.evaluate(async () => {
    const { bytes } = await window.__xlsx.fixture();
    const read = await window.__xlsx.read(bytes);
    const data = read.sheets[0];
    const cellAt = (r, c) =>
      data.celldata.find((entry) => entry.r === r && entry.c === c)?.v ?? null;
    const edited = {
      ...data,
      celldata: data.celldata.map((entry) =>
        entry.r === 1 && entry.c === 0 ? { ...entry, v: { ...entry.v, v: "香蕉", m: "香蕉" } } : entry,
      ),
    };
    const current = [edited, ...read.sheets.slice(1)];
    const written = await window.__xlsx.write({ source: bytes, baseline: read.sheets, current });
    const inspected = await window.__xlsx.inspect(written.bytes);
    const validation = await window.__xlsx.validate(written.bytes, bytes);
    const again = await window.__xlsx.write({ source: bytes, baseline: read.sheets, current: read.sheets });
    return {
      sheets: read.sheets.map((sheet) => ({ name: sheet.name, hide: sheet.hide })),
      active: read.activeSheet,
      a1: cellAt(0, 0),
      b3: cellAt(2, 1),
      b4: cellAt(3, 1),
      a3: cellAt(2, 0),
      hyperlink: data.hyperlink,
      merged: data.config?.merge,
      width: data.config?.columnlen?.[0],
      height: data.config?.rowlen?.[1],
      frozen: data.frozen,
      rows: data.row,
      changedCells: written.changedCells,
      notes: written.notes,
      inspected,
      validation: { ok: validation.ok, issues: validation.issues.map((issue) => issue.message) },
      untouchedChanged: again.changedCells,
      bytes: written.bytes.byteLength,
    };
  });

  check(
    roundTrip.sheets.map((sheet) => sheet.name).join(",") === "数据,说明,隐藏表",
    `三张表都读出来（${roundTrip.sheets.map((sheet) => sheet.name).join("、")}）`,
  );
  check(roundTrip.active === "数据", `活动表读出来（${roundTrip.active}）`);
  check(roundTrip.sheets[2].hide === 1, "隐藏表标记保留（hide=1）");
  check(roundTrip.a1?.v === "名称" && roundTrip.a1?.bl === 1, "文字 + 加粗读出来");
  check(roundTrip.a1?.bg === "#fff2cc", `底色读出来（${roundTrip.a1?.bg}）`);
  check(roundTrip.b3?.ct?.fa === "0.00", `数字格式读出来（${roundTrip.b3?.ct?.fa}）`);
  check(roundTrip.b4?.f === "SUM(B2:B3)", `公式读出来（${roundTrip.b4?.f}）`);
  check(roundTrip.a3?.v === "苹果官网", `超链接文字读出来（${roundTrip.a3?.v}）`);
  check(
    roundTrip.hyperlink?.["2_0"]?.linkAddress === "https://example.com/apple",
    `超链接地址读出来（${roundTrip.hyperlink?.["2_0"]?.linkAddress}）`,
  );
  check(Boolean(roundTrip.merged?.["4_0"]), "合并区域读出来（A5:B5）");
  check(roundTrip.width === 145 && roundTrip.height === 40, `列宽/行高换算（${roundTrip.width}px / ${roundTrip.height}px）`);
  check(
    roundTrip.frozen?.type === "both" && roundTrip.frozen?.range?.row_focus === 1,
    `冻结窗格读出来（${JSON.stringify(roundTrip.frozen)}）`,
  );
  check(roundTrip.rows >= 60, `网格规模够用（${roundTrip.rows} 行）`);

  check(roundTrip.changedCells === 1, `只写改了的那一格（changedCells=${roundTrip.changedCells}）`);
  check(roundTrip.inspected.a2 === "香蕉", `改动落盘（A2=${JSON.stringify(roundTrip.inspected.a2)}）`);
  check(
    roundTrip.inspected.a2note === "这里是批注",
    `批注原样保留（${JSON.stringify(roundTrip.inspected.a2note)}）`,
  );
  check(
    roundTrip.inspected.a3?.hyperlink === "https://example.com/apple",
    `超链接原样保留（${roundTrip.inspected.a3?.hyperlink}）`,
  );
  check(roundTrip.inspected.validations === 1, `数据验证原样保留（${roundTrip.inspected.validations} 条）`);
  check(roundTrip.inspected.b3numFmt === "0.00", `数字格式原样保留（${roundTrip.inspected.b3numFmt}）`);
  check(
    String(roundTrip.inspected.b4?.formula ?? "").length > 0,
    `公式原样保留（${roundTrip.inspected.b4?.formula}）`,
  );
  check(
    JSON.stringify(roundTrip.inspected.merged ?? []) === JSON.stringify(["A5:B5"]),
    `合并区域原样保留（${JSON.stringify(roundTrip.inspected.merged)}）`,
  );
  check(
    Math.abs((roundTrip.inspected.columnWidth ?? 0) - 20) < 0.6 &&
      Math.abs((roundTrip.inspected.rowHeight ?? 0) - 30) < 0.6,
    `列宽/行高原样保留（${roundTrip.inspected.columnWidth} / ${roundTrip.inspected.rowHeight}）`,
  );
  check(roundTrip.inspected.frozen === "frozen", `冻结窗格原样保留（${roundTrip.inspected.frozen}）`);
  check(roundTrip.inspected.hidden === "hidden", `隐藏表原样保留（${roundTrip.inspected.hidden}）`);
  check(
    roundTrip.inspected.notesA2 === 42,
    `另一张表没被动过（说明!A2=${JSON.stringify(roundTrip.inspected.notesA2)}）`,
  );
  check(
    roundTrip.validation.ok,
    `产物校验通过（${roundTrip.validation.issues.join("；") || "无问题"}）`,
  );
  check(roundTrip.untouchedChanged === 0, `没改就不写（changedCells=${roundTrip.untouchedChanged}）`);

  // ② 表级别改动：改名 / 新增 / 删除 之后，别的表的数据不能跟着错位
  const sheetLevel = await page.evaluate(async () => {
    const { bytes } = await window.__xlsx.fixture();
    const read = await window.__xlsx.read(bytes);
    const renamed = [{ ...read.sheets[0], name: "报表" }, ...read.sheets.slice(1)];
    const written = await window.__xlsx.write({ source: bytes, baseline: read.sheets, current: renamed });
    const inspected = await window.__xlsx.inspect(written.bytes, "报表");
    const removed = await window.__xlsx.write({
      source: bytes,
      baseline: read.sheets,
      current: [read.sheets[0]],
    });
    const inserted = await window.__xlsx.write({
      source: bytes,
      baseline: read.sheets,
      current: [read.sheets[0], { name: "新表", celldata: [{ r: 0, c: 0, v: { v: 1 } }] }, ...read.sheets.slice(1)],
    });
    return {
      renamed: { names: inspected.sheetNames, a2: inspected.a2, notesA2: inspected.notesA2, changed: written.changedCells },
      removed: { notes: removed.notes },
      inserted: {
        notes: inserted.notes,
        inspect: await window.__xlsx.inspect(inserted.bytes),
      },
    };
  });
  check(
    sheetLevel.renamed.names.join(",") === "报表,说明,隐藏表",
    `改名写回（${sheetLevel.renamed.names.join("、")}）`,
  );
  check(
    sheetLevel.renamed.a2 === "苹果" && sheetLevel.renamed.notesA2 === 42,
    "改名之后各表内容没有错位",
  );
  check(
    sheetLevel.renamed.changed === 0,
    `改名不被算成"改了很多格子"（changedCells=${sheetLevel.renamed.changed}）`,
  );
  check(
    sheetLevel.removed.notes.some((note) => note.includes("删除工作表")),
    `删除表有明确交代（${sheetLevel.removed.notes.join("；")}）`,
  );
  check(
    sheetLevel.inserted.inspect.sheetNames.join(",") === "数据,新表,说明,隐藏表" &&
      sheetLevel.inserted.inspect.a2 === "苹果",
    `插入表之后各表内容没有错位（${sheetLevel.inserted.inspect.sheetNames.join("、")}）`,
  );

  // ③ 产物校验要能拦住坏产物（少一张表 / 内容掉一大截）
  const validationCases = await page.evaluate(async () => {
    const { bytes } = await window.__xlsx.fixture();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("数据");
    ws.getCell("A1").value = "只剩一格";
    const truncated = await wb.xlsx.writeBuffer();
    return {
      missing: await window.__xlsx.validate(truncated, bytes),
      broken: await window.__xlsx.validate(new Uint8Array([1, 2, 3, 4]).buffer, bytes),
      clean: await window.__xlsx.validate(bytes, bytes),
    };
  });
  check(
    !validationCases.missing.ok &&
      validationCases.missing.issues.some((issue) => issue.kind === "missing-sheet"),
    `校验认出少表（${validationCases.missing.issues.map((issue) => issue.message).join("；")}）`,
  );
  check(
    !validationCases.missing.ok &&
      validationCases.missing.issues.some((issue) => issue.kind === "cells-lost"),
    "校验认出内容掉了一大截",
  );
  check(
    !validationCases.broken.ok && validationCases.broken.issues[0]?.kind === "invalid-xlsx",
    "校验认出打不开的文件",
  );
  check(validationCases.clean.ok, "原样文件校验通过（不误报）");

  // ④ 护栏：带图表的工作簿只给只读
  const guard = await page.evaluate(async () => {
    const { bytes } = await window.__xlsx.fixture({ chart: true });
    const findings = await window.__xlsx.analyze(bytes);
    return { findings, notices: window.__xlsx.summarize(findings) };
  });
  check(
    guard.findings.charts > 0 && guard.notices.some((line) => line.includes("只读")),
    `带图表的工作簿被拦成只读（${guard.notices.join("；")}）`,
  );

  // ⑤ 真样本文件（packages/ui/test/fixtures/office-sample.xlsx）：读 → 改 → 写 → 校验
  const sample = await page.evaluate(async () => {
    const bytes = await (await fetch("/office-sample.xlsx")).arrayBuffer();
    const read = await window.__xlsx.read(bytes);
    const sheet = read.sheets[0];
    const cellAt = (r, c) => sheet.celldata.find((entry) => entry.r === r && entry.c === c)?.v ?? null;
    const edited = {
      ...sheet,
      celldata: sheet.celldata.map((entry) =>
        entry.r === 2 && entry.c === 1 ? { ...entry, v: { ...entry.v, v: 999 } } : entry,
      ),
    };
    const written = await window.__xlsx.write({
      source: bytes,
      baseline: read.sheets,
      current: [edited, ...read.sheets.slice(1)],
    });
    const validation = await window.__xlsx.validate(written.bytes, bytes);
    const inspected = await window.__xlsx.inspect(written.bytes, "销售明细");
    return {
      names: read.sheets.map((item) => item.name),
      hidden: read.sheets[1]?.hide,
      d2: cellAt(1, 3),
      validation: { ok: validation.ok, issues: validation.issues.map((issue) => issue.message) },
      edited: inspected.b3,
      note: inspected.a2note,
      validations: inspected.validations,
    };
  });
  check(
    sample.names.join(",") === "销售明细,内部备注" && sample.hidden === 1,
    `真样本读得出（${sample.names.join("、")}，隐藏表保留）`,
  );
  check(
    sample.d2?.f === "B2*C2",
    `真样本的公式读得出（${sample.d2?.f}）`,
  );
  check(
    sample.edited === 999 && sample.note === "这个价格是含税的" && sample.validations === 1,
    `真样本改一格后批注/数据验证仍在（B3=${sample.edited}）`,
  );
  check(sample.validation.ok, `真样本产物通过校验（${sample.validation.issues.join("；") || "无问题"}）`);

  await harness.close();
  if (failures.length > 0) {
    console.log(`\n${failures.length} 条未通过`);
    process.exitCode = 1;
  } else {
    console.log("\nxlsx 适配层检查全部通过");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
