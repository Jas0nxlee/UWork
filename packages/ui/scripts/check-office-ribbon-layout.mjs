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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const editorDir = join(repoRoot, "packages/ui/src/officeEditor");

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

function App() {
  return <OfficeRibbon style={style} inTable run={() => {}} />;
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

function writeHtml(dir) {
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/harness.css">
<div id="root"></div>
<script type="module" src="/harness.js"></script>`,
    "utf8",
  );
}

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
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.error("缺少 playwright-core：先 pnpm install");
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), "office-ribbon-layout-"));
  await mkdir(dir, { recursive: true });
  const bundleCode = await bundle(dir);
  await emitCss(dir, bundleCode);
  writeHtml(dir);

  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    try {
      const body = readFileSync(join(dir, path === "/" ? "index.html" : path));
      response.writeHead(200, {
        "content-type": path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".html")
            ? "text/html"
            : "text/javascript",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const port = server.address().port;

  const executablePath = process.env.OFFICE_CHECK_CHROMIUM ?? undefined;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  // 视口宽度直接决定功能区宽度（侧栏就是这个场景：可拖宽，窄时最难受）
  const page = await browser.newPage({ viewport: { width: CHECK_WIDTHS[0], height: 400 } });
  // 页面自身的报错要浮上来：否则渲染失败的表现是"某个 click 超时"，很难看出真正原因。
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("[console.error]", message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  const mountedRibbon = await page.evaluate(
    () => document.querySelectorAll("[data-office-ribbon-layout]").length,
  );
  if (mountedRibbon === 0) {
    const html = await page.evaluate(() => document.getElementById("root")?.innerHTML ?? "");
    console.log(`功能区没有渲染出来（root 内容 ${html.length} 字符）：${html.slice(0, 300)}`);
    await browser.close();
    server.close();
    return 1;
  }
  const failures = [];
  const tabButtons = async () =>
    page.$$eval("[data-office-ribbon-layout] > div:first-child button", (nodes) =>
      nodes.map((node) => node.textContent ?? ""),
    );

  const measureAllTabs = async (width) => {
    await page.setViewportSize({ width, height: 400 });
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
  await page.setViewportSize({ width: 460, height: 400 });
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
  await page.setViewportSize({ width: 1280, height: 400 });
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

  const shot = await page.screenshot();
  writeFileSync(join(dir, "ribbon.png"), shot);
  console.log(`截图：${join(dir, "ribbon.png")}（${shot.byteLength} 字节）`);

  await browser.close();
  server.close();
  console.log(`\n失败 ${failures.length} 条`);
  for (const failure of failures) console.log("FAIL", failure);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
