/**
 * Excel 编辑位的**整条产品路径**回归：`useExcelDocument` 真的挂进 React 跑一遍
 * —— 读文件 → 护栏 → 差分写回 → 产物校验 → `writeBinaryFile`（版本比对 / sibling 备份）。
 *
 * 为什么要有这一条：前面三条门禁分别验"引擎能用""适配层保真""功能区落格"，
 * 但**把它们串起来的那条路径**（谁读文件、护栏命中怎么只读、保存时写什么参数、冲突怎么办）
 * 一直是靠真机点。真机点不到的地方就是最容易静默出错的地方，所以这里用一个假 IFileService 把它钉住。
 *
 * 用法：node packages/ui/scripts/check-office-excel-flow.mjs
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
    prefix: "office-excel-flow-",
    pages: { "index.html": EXCEL_PAGE },
    prepareDir: (dir) =>
      bundleExcelEntry(dir, {
        repoRoot,
        editorDir,
        modules: ["xlsxWorkbook.ts", "xlsxValidate.ts", "xlsxPreflight.ts", "useExcelDocument.ts"],
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

  // ① 打开：普通工作簿 → 可编辑、表名齐、状态栏说清了
  const opened = await page.evaluate(async () => {
    const { bytes } = await window.__xlsx.fixture();
    await window.__flow.start({ base64: window.__flow.base64(bytes) });
    window.__flowFixture = bytes;
    return {
      state: window.__flow.state(),
      read: await window.__xlsx.read(bytes).then((result) => result.sheets.map((sheet) => sheet.name)),
    };
  });
  check(opened.state.ready === true, `打开后进入就绪（ready=${opened.state.ready}）`);
  check(
    opened.state.readOnly === false && opened.state.notices.length === 0,
    `普通工作簿不拦（readOnly=${opened.state.readOnly}）`,
  );
  check(
    opened.state.sheetNames?.join(",") === "数据,说明,隐藏表",
    `三张表都进了编辑位（${opened.state.sheetNames?.join("、")}）`,
  );
  check(
    opened.state.status.includes("已载入") && opened.state.status.includes("保存到文件"),
    `状态栏交代清楚（${opened.state.status}）`,
  );

  // ② 改一格 → 保存：写回参数（版本比对 + sibling 备份）与产物内容都要对
  const saved = await page.evaluate(async () => {
    const api = window.__flow;
    const sheets = await window.__xlsx.read(window.__flowFixture).then((result) => result.sheets);
    const edited = sheets.map((sheet, index) =>
      index === 0
        ? {
            ...sheet,
            celldata: sheet.celldata.map((entry) =>
              entry.r === 1 && entry.c === 0 ? { ...entry, v: { ...entry.v, v: "改过了" } } : entry,
            ),
          }
        : sheet,
    );
    api.setSheets(edited);
    await api.save();
    const calls = api.calls();
    const call = calls[calls.length - 1];
    const written = call ? Uint8Array.from(atob(call.dataBase64), (char) => char.charCodeAt(0)) : null;
    const inspected = written ? await window.__xlsx.inspect(written.buffer, "数据") : null;
    const validation = written
      ? await window.__xlsx.validate(written.buffer, window.__flowFixture)
      : null;
    return {
      calls: calls.length,
      expectedRevision: call?.expectedRevision ?? null,
      backup: call?.backup ?? null,
      a2: inspected?.a2 ?? null,
      note: inspected?.a2note ?? null,
      valid: validation?.ok ?? null,
      state: api.state(),
      dirty: api.dirty(),
    };
  });
  check(saved.calls === 1, `保存调了一次写回（${saved.calls} 次）`);
  check(
    saved.expectedRevision?.mtimeMs === 1700000000000 && saved.backup === "sibling",
    `写回带了版本比对与 sibling 备份（${JSON.stringify(saved.expectedRevision)} / ${saved.backup}）`,
  );
  check(saved.a2 === "改过了", `改动落到产物里（A2=${JSON.stringify(saved.a2)}）`);
  check(saved.note === "这里是批注", `产物里的批注没丢（${JSON.stringify(saved.note)}）`);
  check(saved.valid === true, `产物通过校验（${saved.valid}）`);
  check(
    saved.state.status.includes("已保存") && saved.state.dirty === false && saved.dirty === false,
    `保存后状态与脏标记复位（${saved.state.status}）`,
  );

  // ③ 没改动就不写盘
  const untouched = await page.evaluate(async () => {
    const api = window.__flow;
    const before = api.calls().length;
    await api.save();
    return { before, after: api.calls().length, status: api.state().status };
  });
  check(
    untouched.after === untouched.before && untouched.status.includes("没有检测到改动"),
    `没改动时不写盘（${untouched.status}）`,
  );

  // ④ 冲突：服务端说文件被改过 → 明确提示"被其它程序改过"，绝不静默覆盖
  const conflicted = await page.evaluate(async () => {
    const { bytes } = await window.__xlsx.fixture();
    await window.__flow.start({ base64: window.__flow.base64(bytes), failWrite: true });
    const sheets = await window.__xlsx.read(bytes).then((result) => result.sheets);
    window.__flow.setSheets(
      sheets.map((sheet, index) =>
        index === 0
          ? { ...sheet, celldata: [...sheet.celldata, { r: 9, c: 9, v: { v: "新格子" } }] }
          : sheet,
      ),
    );
    await window.__flow.save();
    return window.__flow.state().status;
  });
  check(
    conflicted.includes("保存被拒") && conflicted.includes("重新加载"),
    `冲突时明确拒绝并给出路（${conflicted}）`,
  );

  // ⑤ 护栏命中的工作簿：只读、且**保存不写盘**
  const guarded = await page.evaluate(async () => {
    const { bytes } = await window.__xlsx.fixture({ chart: true });
    await window.__flow.start({ base64: window.__flow.base64(bytes) });
    const before = window.__flow.calls().length;
    await window.__flow.save();
    return { state: window.__flow.state(), writes: window.__flow.calls().length - before };
  });
  check(
    guarded.state.readOnly === true && guarded.state.notices.some((line) => line.includes("只读")),
    `带图表的工作簿被拦成只读（${guarded.state.notices.join("；")}）`,
  );
  check(
    guarded.writes === 0 && guarded.state.status.includes("只读"),
    `只读工作簿保存不写盘（${guarded.state.status}）`,
  );

  await harness.close();
  if (failures.length > 0) {
    console.log(`\n${failures.length} 条未通过`);
    process.exitCode = 1;
  } else {
    console.log("\nExcel 编辑位整条路径检查全部通过");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
