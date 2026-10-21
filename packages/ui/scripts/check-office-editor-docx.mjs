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

  // 修订/批注：正文里按 Word 的样子显示，保存时原样写回（不再用横幅告知）
  const revisionView = await page.evaluate(() => window.__revisionViewCase());
  check(
    revisionView.summary.inserted === 1 &&
      revisionView.summary.deleted === 1 &&
      revisionView.summary.comments === 1,
    `识别修订/批注（插入 ${revisionView.summary.inserted} / 删除 ${revisionView.summary.deleted} / 批注 ${revisionView.summary.comments}）`,
  );
  check(
    revisionView.bodyShowsInserted && revisionView.insertedUnderlined,
    "插入的正文看得见且按 Word 的样子标出（下划线 + 蓝色）",
  );
  check(revisionView.deletedStruck, "被删除的正文按 Word 的样子显示（红色删除线，文字不消失）");
  check(revisionView.commentShaded, "批注锚点按 Word 的样子加浅底纹（不再注入自造标记）");
  check(
    revisionView.savedHasIns && revisionView.savedHasDel && revisionView.savedHasCommentRef,
    `保存时原样写回修订与批注（w:ins/w:del/commentReference 都在，写回 ${revisionView.restored} 段）`,
  );

  // 审阅：Word 的接受/拒绝语义（枚举 → 逐条 → 全部）
  const review = await page.evaluate(() => window.__reviewCase());
  check(
    review.listed.join(" ") === "insert:INS1 delete:DEL2 insert:INS3",
    `修订按文档顺序枚举（${review.listed.join(" / ")}）`,
  );
  check(
    review.acceptOneRemaining === 2 &&
      review.acceptOneText.includes("AAA") &&
      review.acceptOneText.includes("INS1") &&
      !new RegExp("<w:ins[ >]").test(
        review.acceptOneText.slice(0, review.acceptOneText.indexOf("INS1")),
      ),
    "接受第一条插入＝拆壳保留文字（剩下 2 条）",
  );
  check(
    review.rejectOneRemaining === 2 &&
      review.rejectOneText.includes("DEL2") &&
      !new RegExp("<w:del[ >]").test(review.rejectOneText),
    "拒绝第一条删除＝被删的文字还原为正文（剩下 2 条）",
  );
  check(
    review.acceptAllText.includes("INS1") &&
      review.acceptAllText.includes("INS3") &&
      !review.acceptAllText.includes("DEL2") &&
      !new RegExp("<w:(ins|del)[ >]").test(review.acceptAllText),
    "接受全部＝插入成正文、删除消失、无标记残留",
  );
  check(
    review.rejectAllText.includes("DEL2") &&
      !review.rejectAllText.includes("INS1") &&
      !review.rejectAllText.includes("INS3") &&
      !new RegExp("<w:(ins|del)[ >]").test(review.rejectAllText),
    "拒绝全部＝插入消失、删除的文字还原为正文",
  );

  // 批注：内容解析 + 正文标记对应（Word 的审阅窗格就是这张表）
  const comments = await page.evaluate(() => window.__commentCase());
  check(
    comments.count === 2 &&
      comments.authors.join("/") === "张审阅/李审阅" &&
      comments.texts.join("/") === "这里要改/这句不通",
    `批注解析出作者与内容（${comments.authors.join("、")}：${comments.texts.join("；")}）`,
  );
  check(
    comments.anchors.join(" / ") === "被批注的一句话 / 第二处锚点",
    `批注锚点按 Word 的 commentRangeStart/End 解析（${comments.anchors.join(" / ")}）`,
  );
  check(
    comments.bodyShaded && !comments.bodyHasInventedMarker,
    "锚点范围加浅底纹、正文里不再注入自造标记（[$n] 已去掉）",
  );

  // 批注的引擎侧能力：用官方 demo 的那套 API（建组/取矩形/定位/删除）在真引擎上跑一遍
  const commentGroup = await page.evaluate(() => window.__commentGroupCase());
  check(
    commentGroup.groupId && commentGroup.inIdList && commentGroup.rects > 0,
    `批注用引擎 group（demo 的做法）：建组成功、列出 ${commentGroup.rects} 个矩形`,
  );
  check(
    commentGroup.rectAfterLocate > 0 && commentGroup.deleted,
    "定位（executeLocationGroup）与删除（executeDeleteGroup）都在真引擎上生效",
  );

  // 批注框排版（Word 的批注框：按锚点高度对齐、重叠往下让、无锚点排最后）
  const balloons = await page.evaluate(() => window.__balloonCase());
  const byId = Object.fromEntries(balloons.map((entry) => [entry.id, entry.top]));
  // a 在 10（高 60）→ b 想贴 40 但会压在 a 上，被让到 78；c 想贴 60 同样重叠 → 146；无锚点的排最后
  check(
    byId.a === 10 && byId.b === 78 && byId.c === 146 && byId.d === 194,
    `批注框排版正确（按锚点排序且重叠让位：a=${byId.a} b=${byId.b} c=${byId.c} 无锚点=${byId.d} 在最后）`,
  );

  // 删除批注：正文不动、这条的锚点真的没了、另一条不受影响、段落原件同步（保存不会带回来）
  const deleted = await page.evaluate(() => window.__deleteCommentCase());
  check(
    deleted.removed === 1 && deleted.goneFirst && deleted.keepSecond && deleted.bodyKept,
    "删除批注：这条锚点从字节里去掉、另一条保留、正文一个字没动",
  );
  check(
    deleted.preservationGoneFirst && deleted.preservationKeepSecond && deleted.commentsLeft === 1,
    "段落原件也同步去掉（否则保存时会被写回，表现为「删不掉」）",
  );

  // 审阅导航的滚动：视野内不动、可见区外按缩放滚到位（真机反馈"上下箭头不跟随"）
  const navScroll = await page.evaluate(() => window.__navScrollCase());
  check(
    navScroll.inside === null &&
      navScroll.below === 1676 &&
      navScroll.above === 76 &&
      navScroll.zoomed === 726,
    `审阅导航的滚动判定正确（视野内→不动；下方 1700→1676；上方 100→76；缩放 1.5 时 500→726）`,
  );

  // 写回前校验：好产物放行；四类坏产物必须被拦下（这是"写坏用户文件"的最后一道闸）
  const validation = await page.evaluate(() => window.__validateCase());
  check(
    validation.good.ok,
    `产出的 docx 通过校验（问题码：${JSON.stringify(validation.good.codes)}）`,
  );
  check(
    !validation.collapsed.ok && validation.collapsed.codes.includes("content-collapsed"),
    `正文塌陷被拦下（${JSON.stringify(validation.collapsed.codes)}）`,
  );
  check(
    !validation.dangling.ok && validation.dangling.codes.includes("dangling-relationship"),
    `断关系被拦下（${JSON.stringify(validation.dangling.codes)}）`,
  );
  check(
    !validation.truncated.ok && validation.truncated.codes.includes("invalid-xml"),
    `XML 截断被拦下（${JSON.stringify(validation.truncated.codes)}）`,
  );
  check(
    !validation.missingPart.ok && validation.missingPart.codes.includes("missing-part"),
    `缺必备部件被拦下（${JSON.stringify(validation.missingPart.codes)}）`,
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
  // 修订/批注**不再**进清单：它们按 Word 的样子显示在正文里、保存时原样写回（真机口径：
  // "这种修改直接通过插件就可以实现，editor 应该按 office 的批注显示和修改方式"）
  const notices = preflight.changes.join(" | ");
  check(
    preflight.changes.length <= 3 &&
      !notices.includes("修订") &&
      !notices.includes("批注") &&
      notices.includes("超链接"),
    `预检只列"真会丢内容/形态"的项、不含修订与批注（${preflight.changes.length} 条：${notices}）`,
  );
  await page.evaluate(
    (bytes) => window.__loadPreprocessed(new Uint8Array(bytes).buffer),
    preflight.bytes,
  );
  const trickyText = (await state()).text;
  // 这一段只验「归一化」：超链接/公式/结构项的文字保住；修订与批注由下面的 revision view 用例负责
  check(
    trickyText.includes("LINKTEXT") && trickyText.includes("E=mc^2"),
    `归一化后超链接与公式的文字都还在（文本：${JSON.stringify(trickyText.slice(0, 80))}）`,
  );

  const shot = await page.screenshot();
  writeFileSync(join(harness.dir, "docx.png"), shot);
  await harness.close();

  console.log(`\n失败 ${failures.length} 条`);
  for (const failure of failures) console.log("FAIL", failure);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
