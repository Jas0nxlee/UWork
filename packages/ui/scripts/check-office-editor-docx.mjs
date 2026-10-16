/**
 * 编辑区的**文档数据安全**回归：预检护栏、修订模式、页眉页脚、写能力探测。
 *
 * 与 check-office-editor-behavior.mjs 的分工：那个脚本管"命令与渲染"（纸张/控件/分页/缩放/查找替换…），
 * 这个脚本管"动到文件内容的事"——它守的是最不能出错的一类：**不许静默改坏用户文档**。
 *
 * 用法：node packages/ui/scripts/check-office-editor-docx.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BEHAVIOR_PAGE, bundleDispatcher } from "./lib/officeBehaviorPage.mjs";
import { buildTrickyDocx } from "./lib/officeCheckFixtures.mjs";
import { engineAssetPaths, startOfficeHarness } from "./lib/officeEditorHarness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

async function main() {
  const assets = engineAssetPaths(repoRoot);
  const harness = await startOfficeHarness({
    prefix: "office-docx-",
    pages: { "index.html": BEHAVIOR_PAGE },
    copies: {
      [assets.engine]: "ce/canvas-editor.js",
      [assets.docxPlugin]: "ce/docx.js",
      [assets.docxFixture]: "sample.docx",
      [assets.imageFixture]: "image.png",
      [assets.jszip]: "jszip.js",
    },
    prepareDir: (dir) => bundleDispatcher(dir, editorDir),
  });
  const page = harness.page;
  const failures = [];
  const check = (ok, message) => {
    if (ok) console.log(`ok   ${message}`);
    else {
      console.log(`FAIL ${message}`);
      failures.push(message);
    }
  };
  const state = async () => page.evaluate(() => window.__state());

  // 修订模式：改动落成 w:ins/w:del，且"接受＝编辑后 / 拒绝＝基线"
  const tracked = await page.evaluate(() => window.__trackChangesCase());
  check(
    tracked.stats.modified === 1 && tracked.stats.inserted === 1 && tracked.stats.deleted === 1,
    `修订统计正确（修改 ${tracked.stats.modified} / 新增 ${tracked.stats.inserted} / 删除 ${tracked.stats.deleted}）`,
  );
  check(
    tracked.hasIns && tracked.hasDel && tracked.hasDelText,
    "导出里出现 w:ins / w:del / w:delText",
  );
  check(
    tracked.accepted === tracked.editedText,
    `接受全部修订 == 编辑后的样子（得到 ${JSON.stringify(tracked.accepted)}）`,
  );
  check(
    tracked.rejected === tracked.baselineText,
    `拒绝全部修订 == 基线（得到 ${JSON.stringify(tracked.rejected)}）`,
  );

  // 页眉页脚：源有则原样保留（含 logo 等侧车文件），源没有则不让插件默认页脚留下来
  const hfCases = await page.evaluate(() => window.__headerFooterCases());
  check(
    hfCases.plain.footerRefs === 0 && hfCases.plain.headerRefs === 0 && !hfCases.plain.footerText,
    `源文档没有页眉页脚时，导出的页脚被撤掉（引用 ${hfCases.plain.footerRefs}，部件 ${JSON.stringify(hfCases.plain.parts)}）`,
  );
  check(
    hfCases.withFooter.footerText.includes("FOOTER-MARK") && hfCases.withFooter.footerRefs === 1,
    `源文档有页脚时原样保留（${hfCases.withFooter.note}）`,
  );

  // 远端写能力探测：老远端（Method not found）要判"不能编辑"，新远端（版本不匹配）判"可以"
  const probes = await page.evaluate(async () => ({
    old: await window.__probeWrite("old-remote"),
    fresh: await window.__probeWrite("new-remote"),
    ok: await window.__probeWrite("writable"),
  }));
  check(
    probes.old.supported === false &&
      probes.fresh.supported === true &&
      probes.ok.supported === true,
    `写能力探测：老远端不支持（${probes.old.reason ?? ""}）／新远端支持／本地支持`,
  );

  // 护栏：含修订/超链接/公式/批注的文档必须先被识别，归一化后**文字不丢**
  const trickyDocx = await buildTrickyDocx();
  const preflight = await page.evaluate(async (bytes) => {
    const result = await window.__preflight.preprocessDocx(bytes);
    return {
      findings: result.findings,
      changes: result.changes,
      bytes: Array.from(new Uint8Array(result.bytes)),
    };
  }, Array.from(trickyDocx));
  const f = preflight.findings;
  check(
    f.revisions.inserted === 1 &&
      f.revisions.deleted === 1 &&
      f.hyperlinks === 1 &&
      f.formulas === 1 &&
      f.comments === 1,
    `预检认出文档特性：插入 ${f.revisions.inserted} / 删除 ${f.revisions.deleted} / 超链接 ${f.hyperlinks} / 公式 ${f.formulas} / 批注 ${f.comments}`,
  );
  check(
    preflight.changes.length >= 4,
    `预检给出了会说清楚的改动清单（${preflight.changes.length} 条，例：${preflight.changes[0] ?? ""}）`,
  );
  await page.evaluate(
    (bytes) => window.__loadPreprocessed(new Uint8Array(bytes).buffer),
    preflight.bytes,
  );
  const trickyText = (await state()).text;
  check(
    trickyText.includes("INSERTED") &&
      trickyText.includes("LINKTEXT") &&
      trickyText.includes("E=mc^2"),
    `归一化后插入文字/超链接文字/公式文字都还在（文本：${JSON.stringify(trickyText.slice(0, 80))}）`,
  );
  check(!trickyText.includes("DELETED"), "被删除的文字没有复活（w:del 按「接受删除」处理）");

  const shot = await page.screenshot();
  writeFileSync(join(harness.dir, "docx.png"), shot);
  await harness.close();

  console.log(`\n失败 ${failures.length} 条`);
  for (const failure of failures) console.log("FAIL", failure);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
