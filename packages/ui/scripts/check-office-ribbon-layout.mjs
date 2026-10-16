/**
 * 功能区**布局**回归检查（在无头 Chromium 里渲染真实组件、量真实高度）。
 *
 * 为什么要有它：功能区改过好几轮，用户报的都是"看着不对"这类问题，肉眼看一遍很难覆盖
 * 宽度 × 标签的组合。这里把三条真机反馈固化成断言：
 *   ① 切标签时整块高度不能跳（开始有样式库、最高；其它标签矮一截就会被看出来）；
 *   ② 同时只能有一个下拉打开（点第二个时第一个要消失）；
 *   ③ 三级自适应按宽度生效，窄栏要把次要命令收进「⋯」而不是硬挤。
 *
 * 渲染方式：esbuild 把 OfficeRibbon 打成单文件 + tailwind 现场生成所需 CSS，
 * 与 check-office-editor-commands.mjs 同一套路（node 起静态服务 + playwright 无头壳）。
 *
 * 用法：node packages/ui/scripts/check-office-ribbon-layout.mjs
 * 依赖：仓库已装的 esbuild / tailwindcss / react / playwright-core 与无头 Chromium。
 */
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startOfficeHarness } from "./lib/officeEditorHarness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");
/** 插入图片用的小样本（240×120 PNG，由 scripts/make-image-fixture.mjs 生成后入库）。 */
const imageFixture = join(repoRoot, "packages/ui/test/fixtures/office-editor-image.png");

/**
 * 要检查的宽度：从"宽到放得下全部"到"比侧栏最窄还窄"。功能区现在按实测宽度取舍分组，
 * 所以每个宽度都必须满足：不出横向滚动条、切标签不跳高度、藏起来的分组能从「»」里点到。
 */
const CHECK_WIDTHS = (process.env.RIBBON_CHECK_WIDTHS ?? "1600,1280,1040,900,760,660,560,460")
  .split(",")
  .map(Number);

/** 渲染入口：真实组件 + 一份够用的 style（下拉要显示当前值，所以给上 font/size）。 */
const ENTRY = `
import { createRoot } from "react-dom/client";
import { OfficeRibbon } from ${JSON.stringify(join(editorDir, "OfficeRibbon.js"))};
import { OfficeEditorToolbar } from ${JSON.stringify(join(editorDir, "OfficeEditorToolbar.js"))};

const style = {
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
  painter: false,
  undo: true,
  redo: true,
  rowFlex: "left",
  level: null,
  listType: null,
  font: "SimSun, Songti SC, STSong, serif",
  size: 16,
  color: null,
  highlight: null,
};

// 记录回调，供"需要填值的命令"断言（图片/链接/公式走对话框取值）
window.__calls = [];
function App() {
  // 顶栏也渲染：状态文字会随导航变化，它必须不改变高度（否则整块菜单栏会跳）
  return (
    <>
      <OfficeEditorToolbar
        busy={false}
        dirty
        status={"已载入 3 KiB · 修订 12 插入 / 12 删除 · 批注 6 处（按 Word 的方式显示在正文里，保存时原样写回）"}
        onSave={() => {}}
        onReload={() => {}}
      />
      <OfficeRibbon style={style} inTable run={(command, args) => window.__calls.push([command, args])} />
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
`;

const THEME_CSS = `@import "tailwindcss";
@theme {
  --color-background: #141414;
  --color-surface: #1f1f1f;
  --color-border: #3a3a3a;
  --color-foreground: #f2f2f2;
  --color-foreground-subtle: #b0b0b0;
  --color-foreground-subtlest: #808080;
}
body { margin: 0; background: #141414; color: #f2f2f2; font-family: system-ui, sans-serif; }
`;

/** 从打好的包里抠出候选类名喂给 tailwind（等价于 CLI 扫源码，省得维护 @source）。 */
function candidatesFrom(bundle) {
  const tokens = new Set();
  for (const match of bundle.matchAll(/["'`]([^"'`\n]{1,400})["'`]/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (/^-?[a-z@![]/i.test(token) && /^[-\w@!:./[\]%(),#]+$/.test(token)) tokens.add(token);
    }
  }
  return [...tokens];
}

async function emitCss(dir, bundle) {
  const { compile } = await import("tailwindcss");
  const loadStylesheet = async (id, base) => {
    const { readFile } = await import("node:fs/promises");
    const path =
      id === "tailwindcss"
        ? join(repoRoot, "node_modules/tailwindcss/index.css")
        : resolve(base, id);
    return { path, base: dirname(path), content: await readFile(path, "utf8") };
  };
  const compiler = await compile(THEME_CSS, { base: repoRoot, loadStylesheet });
  const css = compiler.build(candidatesFrom(bundle));
  await writeFile(join(dir, "harness.css"), css, "utf8");
}

async function bundle(dir) {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    stdin: {
      contents: ENTRY,
      resolveDir: editorDir,
      loader: "tsx",
      sourcefile: "ribbon-harness.tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    absWorkingDir: repoRoot,
  });
  const code = result.outputFiles[0].text;
  writeFileSync(join(dir, "harness.js"), code, "utf8");
  return code;
}

const HTML = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/harness.css">
<div id="root"></div>
<script type="module" src="/harness.js"></script>`;

/** 逐标签量"标签行下方那一条"的高度：就是用户看到的跳动来源。 */
const MEASURE = () => {
  const row = document.querySelector("[data-office-ribbon-groups]");
  const root = document.querySelector("[data-office-ribbon-layout]");
  return {
    tab: row?.getAttribute("data-office-ribbon-groups") ?? null,
    layout: root?.getAttribute("data-office-ribbon-layout") ?? null,
    groupsHeight: row ? Math.round(row.getBoundingClientRect().height) : 0,
    rootHeight: root ? Math.round(root.getBoundingClientRect().height) : 0,
    /** 内容需要的宽度：溢出时就说明这一级放不下（不许出现横向滚动条）。 */
    contentWidth: row ? Math.round(row.scrollWidth) : 0,
    containerWidth: row ? Math.round(row.clientWidth) : 0,
    /** 收起的分组按钮：窄栏里每个分组一个（标题里带"整组收进这里"）。 */
    collapsedGroups: document.querySelectorAll("[data-office-ribbon-collapsed]").length,
    hasMoreMenu: Boolean(document.querySelector("button[data-office-ribbon-more]")),
    groups: row
      ? [...row.children].map((child) => ({
          width: Math.round(child.getBoundingClientRect().width),
          label: (child.textContent ?? "").trim().slice(0, 6),
        }))
      : [],
    openDropdowns: document.querySelectorAll("[data-ribbon-dropdown]").length,
    badge:
      document.querySelector('[data-office-ribbon-layout] span[class*="ml-auto"]')?.textContent ??
      null,
    groupsRendered: document.querySelectorAll("[data-office-ribbon-group]").length,
  };
};

async function main() {
  const harness = await startOfficeHarness({
    prefix: "office-ribbon-layout-",
    pages: { "index.html": HTML },
    viewport: { width: CHECK_WIDTHS[0], height: 700 },
    // 组件包与 CSS 都是现场构建的，必须在页面加载前写好
    prepareDir: async (dir) => {
      const code = await bundle(dir);
      await emitCss(dir, code);
    },
  });
  const page = harness.page;
  const failures = [];
  const tabButtons = async () =>
    page.$$eval("[data-office-ribbon-layout] > div:first-child button", (nodes) =>
      nodes.map((node) => node.textContent ?? ""),
    );

  const measureAllTabs = async (width) => {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(80);
    const labels = await tabButtons();
    const rows = [];
    for (const label of labels) {
      await page.click(`[data-office-ribbon-layout] > div:first-child button:text-is("${label}")`);
      await page.waitForTimeout(40);
      const measured = await page.evaluate(MEASURE);
      if (process.env.RIBBON_DUMP_TEXT) {
        const text = await page.evaluate(
          () => document.querySelector("[data-office-ribbon-groups]")?.textContent ?? "",
        );
        console.log(`    DOM: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
      }
      rows.push({ label, ...measured });
    }
    for (const row of rows)
      console.log(
        `宽度 ${width} [${row.layout}] ${row.label}：分组行 ${row.groupsHeight}px · 内容 ${row.contentWidth}/${row.containerWidth}px · 收起 ${row.collapsedGroups} 组${row.hasMoreMenu ? " · 有 »" : ""}`,
      );
    return rows;
  };

  // ① 每个宽度都要满足：不横滚、切标签不跳高度、该收的分组收起来了。
  for (const width of CHECK_WIDTHS) {
    const rows = await measureAllTabs(width);
    const heights = [...new Set(rows.map((row) => row.groupsHeight))];
    if (heights.length > 1)
      failures.push(
        `宽度 ${width}：标签高度不一致 ${rows.map((row) => `${row.label}=${row.groupsHeight}`).join(" / ")}`,
      );
    for (const row of rows) {
      if (row.contentWidth > row.containerWidth + 1) {
        const widest = [...row.groups].sort((a, b) => b.width - a.width).slice(0, 3);
        failures.push(
          `宽度 ${width} ${row.label}：内容 ${row.contentWidth}px > 容器 ${row.containerWidth}px（会出横向滚动条）；最宽 ${widest
            .map((group) => `${group.label}=${group.width}`)
            .join(" / ")}`,
        );
      }
      // 藏起来的分组必须有「»」入口，而且「»」本身不能把行撑出去
      if (!row.hasMoreMenu && row.contentWidth > row.containerWidth + 1)
        failures.push(`宽度 ${width} ${row.label}：放不下却没有「»」入口`);
    }
  }

  // ② 极窄宽度（460px，比侧栏最窄还窄）下放不下的分组要能从「»」里点到，不是凭空消失。
  await page.setViewportSize({ width: 460, height: 700 });
  await page.waitForTimeout(120);
  await page.click('[data-office-ribbon-tab="home"]');
  await page.waitForTimeout(120);
  const beforeMore = await page.evaluate(MEASURE);
  if (!beforeMore.hasMoreMenu) {
    failures.push("宽度 460 开始标签：没有「»」入口（这个宽度按实测放不下全部四组）");
  } else {
    await page.click("button[data-office-ribbon-more]");
    await page.waitForTimeout(80);
    const moreMenu = await page.evaluate(() => {
      const panel = document.querySelector("[data-ribbon-dropdown]");
      return {
        open: document.querySelectorAll("[data-ribbon-dropdown]").length,
        buttons: panel ? panel.querySelectorAll("button").length : 0,
        height: panel ? Math.round(panel.getBoundingClientRect().height) : 0,
      };
    });
    console.log(`「»」菜单：面板 ${moreMenu.height}px · ${moreMenu.buttons} 个可点项`);
    if (moreMenu.buttons < 6) failures.push(`「»」菜单里的命令太少（${moreMenu.buttons} 项）`);
  }

  // ③ 单一打开源：点开第二个下拉时，第一个必须已经关掉。
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.waitForTimeout(120);
  await page.click('[data-office-ribbon-tab="home"]');
  await page.waitForTimeout(120);
  await page.click('[data-office-ribbon-groups] button[title="字体"]');
  await page.waitForTimeout(80);
  const openedFirst = await page.evaluate(() => ({
    open: document.querySelectorAll("[data-ribbon-dropdown]").length,
  }));
  await page.click('[data-office-ribbon-groups] button[title="字号"]');
  await page.waitForTimeout(80);
  const openedSecond = await page.evaluate(() => ({
    open: document.querySelectorAll("[data-ribbon-dropdown]").length,
    text: document.querySelector("[data-ribbon-dropdown]")?.textContent?.slice(0, 24) ?? null,
  }));
  console.log(
    `下拉互斥：先 ${openedFirst.open} 个 → 点第二个后 ${openedSecond.open} 个（${openedSecond.text}）`,
  );
  if (openedFirst.open !== 1)
    failures.push(`先点「字体」后应有 1 个下拉，实际 ${openedFirst.open}`);
  if (openedSecond.open !== 1)
    failures.push(`点「字号」后应只剩 1 个下拉，实际 ${openedSecond.open}`);

  // 面板必须真的可见（曾经被功能区的 overflow 裁掉，只剩两行）
  const panelBox = await page.evaluate(() => {
    const panel = document.querySelector("[data-ribbon-dropdown]");
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return {
      height: Math.round(rect.height),
      insideViewport: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
      insideWindow: rect.left >= 0 && rect.right <= window.innerWidth + 1,
    };
  });
  console.log(`下拉面板：${JSON.stringify(panelBox)}`);
  if (!panelBox || panelBox.height < 60)
    failures.push(`下拉面板高度异常（${panelBox?.height ?? 0}px），疑似又被裁掉`);
  if (panelBox && !panelBox.insideViewport) failures.push("下拉面板超出视口（应该被夹取在视口内）");
  if (panelBox && !panelBox.insideWindow) failures.push("下拉面板横向超出窗口");

  // ④ 两个"不是普通按钮"的面板：表格网格与查找替换（真机反馈后新做的）
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.waitForTimeout(120);
  await page.click('[data-office-ribbon-tab="insert"]');
  await page.waitForTimeout(120);
  await page.click("button[data-office-ribbon-table]");
  await page.waitForTimeout(100);
  const tablePanel = await page.evaluate(() => {
    const cells = document.querySelectorAll("[data-office-ribbon-table-cell]");
    const panel = document.querySelector("[data-ribbon-dropdown]");
    const box = panel?.getBoundingClientRect();
    return {
      cells: cells.length,
      rows: new Set([...cells].map((cell) => cell.getAttribute("aria-label"))).size,
      inside: Boolean(box && box.top >= 0 && box.bottom <= window.innerHeight + 1),
    };
  });
  console.log(`表格网格：${tablePanel.cells} 个格子 · 面板在视口内 ${tablePanel.inside}`);
  if (tablePanel.cells < 80)
    failures.push(`表格网格只有 ${tablePanel.cells} 个格子，应该是 10×8=80`);
  if (!tablePanel.inside) failures.push("表格网格面板超出视口");
  const tableShot = await page.screenshot();
  writeFileSync(join(harness.dir, "ribbon-table.png"), tableShot);

  await page.click('[data-office-ribbon-tab="view"]');
  await page.waitForTimeout(120);
  await page.click("button[data-office-ribbon-find]");
  await page.waitForTimeout(100);
  const findPanel = await page.evaluate(() => {
    const panel = document.querySelector("[data-ribbon-dropdown]");
    return {
      inputs: panel ? panel.querySelectorAll("input").length : 0,
      buttons: panel ? panel.querySelectorAll("button").length : 0,
    };
  });
  console.log(`查找替换面板：${findPanel.inputs} 个输入框 · ${findPanel.buttons} 个按钮`);
  if (findPanel.inputs < 2) failures.push(`查找替换面板输入框不足（${findPanel.inputs}）`);
  if (findPanel.buttons < 5) failures.push(`查找替换面板按钮不足（${findPanel.buttons}）`);
  const findShot = await page.screenshot();
  writeFileSync(join(harness.dir, "ribbon-find.png"), findShot);

  // ④b 顶栏高度必须与状态文字长度无关（真机反馈：点上下箭头时"最上面的菜单栏会跳一下"）
  const toolbarHeights = await page.evaluate(() => {
    const toolbar = document.querySelector("[data-office-toolbar]");
    return toolbar ? Math.round(toolbar.getBoundingClientRect().height) : null;
  });
  console.log(
    `顶栏高度：${toolbarHeights}px（状态很长时也必须单行——真机反馈"点上下箭头菜单栏会跳一下"）`,
  );
  if (!toolbarHeights || toolbarHeights > 48)
    failures.push(`顶栏高度 ${toolbarHeights}px：状态文字变长时换行了（整块菜单栏会跳）`);

  // ⑤ 需要填值的命令（图片/链接/公式）：Electron 没有 window.prompt，必须走我们的对话框
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.waitForTimeout(120);
  await page.click('[data-office-ribbon-tab="insert"]');
  await page.waitForTimeout(120);
  // 图片：必须能"从本机选文件"（真机反馈），选完把文件的 data URI 传进命令
  await page.evaluate(() => {
    window.__calls.length = 0;
  });
  await page.click('button[data-office-ribbon-prompt="executeImage"]');
  await page.waitForTimeout(80);
  const picker = await page.evaluate(() => ({
    hasPicker: Boolean(document.querySelector("button[data-office-ribbon-prompt-pick]")),
    hasFileInput: Boolean(document.querySelector("input[data-office-ribbon-prompt-file]")),
  }));
  if (!picker.hasFileInput)
    failures.push("插入图片的对话框里没有文件选择控件（应该能从本机选图片）");
  await page.setInputFiles("input[data-office-ribbon-prompt-file]", imageFixture);
  await page.waitForTimeout(300);
  const imageCall = await page.evaluate(() => window.__calls.at(-1) ?? null);
  const dataUri = imageCall?.[1]?.[0] ?? "";
  console.log(
    `图片取值：选择控件 ${picker.hasPicker} · 文件框 ${picker.hasFileInput} · 传参 ${String(dataUri).slice(0, 32)}…（${String(dataUri).length} 字符）`,
  );
  if (!String(dataUri).startsWith("data:image/png;base64,"))
    failures.push(`从本机选图片后没有传 data URI（拿到 ${String(dataUri).slice(0, 40)}）`);

  for (const [command, value] of [
    ["executeHyperlink", "https://example.com"],
    ["executeLatex", "E=mc^2"],
  ]) {
    await page.evaluate(() => {
      window.__calls.length = 0;
    });
    await page.click(`button[data-office-ribbon-prompt="${command}"]`);
    await page.waitForTimeout(80);
    const dialog = await page.evaluate(() => {
      const input = document.querySelector('[role="dialog"] input');
      return { hasDialog: Boolean(input), focused: document.activeElement === input };
    });
    if (!dialog.hasDialog) {
      failures.push(
        `${command}：点开后没有取值对话框（Electron 里 window.prompt 没有实现，必须自己弹）`,
      );
      continue;
    }
    await page.fill('[role="dialog"] input', value);
    await page.click("button[data-office-ribbon-prompt-submit]");
    await page.waitForTimeout(80);
    const calls = await page.evaluate(() => window.__calls);
    const ok =
      calls.length === 1 && calls[0][0] === command && JSON.stringify(calls[0][1]).includes(value);
    console.log(
      `取值对话框 ${command}：${dialog.hasDialog ? "有" : "无"}对话框 · 提交后调用 ${JSON.stringify(calls)}`,
    );
    if (!ok)
      failures.push(`${command}：对话框提交后没有把填的值带进命令（${JSON.stringify(calls)}）`);
  }

  const shot = await page.screenshot();
  writeFileSync(join(harness.dir, "ribbon.png"), shot);
  console.log(`截图：${join(harness.dir, "ribbon.png")}（${shot.byteLength} 字节）`);

  await harness.close();
  console.log(`\n失败 ${failures.length} 条`);
  for (const failure of failures) console.log("FAIL", failure);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
