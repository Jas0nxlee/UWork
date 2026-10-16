/**
 * office 编辑器/功能区回归检查的**共享脚手架**：临时目录 + 静态服务 + 无头 Chromium。
 *
 * 抽出来的原因：两个检查脚本各自都写过一遍同样的东西（临时目录、content-type 映射、启动参数、
 * pageerror 上报），既容易漂，也让脚本本身超出仓库的 400 行上限。现在只留"检查什么"在脚本里。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CONTENT_TYPES = [
  [".html", "text/html"],
  [".css", "text/css"],
  [".png", "image/png"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
];

function contentTypeFor(path) {
  const match = CONTENT_TYPES.find(([suffix]) => path.endsWith(suffix));
  return match ? match[1] : "text/javascript";
}

/**
 * 起一个"临时目录里的静态站点 + 无头页面"。
 *
 * @param options.prefix 临时目录前缀（便于在 /tmp 里认出来）
 * @param options.pages 需要写入的文件（相对临时目录的路径 → 内容）
 * @param options.copies 需要复制进来的仓库内文件（源路径 → 临时目录里的名字）
 * @param options.prepareDir 起浏览器之前再说一声：目录已建好，可以往里打构建产物（esbuild 等）
 * @param options.viewport 初始视口（默认 900×700）
 * @returns {{ dir: string, page: import("playwright-core").Page, close: () => Promise<void> }}
 */
export async function startOfficeHarness(options) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("缺少 playwright-core：先 pnpm install");
  }
  const dir = mkdtempSync(join(tmpdir(), options.prefix));
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(options.pages)) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  for (const [source, name] of Object.entries(options.copies ?? {})) {
    const file = join(dir, name);
    await mkdir(dirname(file), { recursive: true });
    await cp(source, file);
  }

  // 打产物必须在起浏览器之前：页面一加载就会去 import 这些文件，晚写就是 404
  await options.prepareDir?.(dir);

  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    try {
      const body = readFileSync(join(dir, path === "/" ? "index.html" : path));
      response.writeHead(200, { "content-type": contentTypeFor(path) });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const port = server.address().port;

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.OFFICE_CHECK_CHROMIUM
      ? { executablePath: process.env.OFFICE_CHECK_CHROMIUM }
      : {}),
  });
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 900, height: 700 },
  });
  // 页面自身的报错必须浮上来：否则失败会表现成"某个 click 超时"，看不出真正原因
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("[console.error]", message.text());
  });
  await page.goto(`http://127.0.0.1:${port}/index.html`);

  return {
    dir,
    page,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/** 仓库内的引擎/插件产物路径（两个检查脚本都要用同一份）。 */
export function engineAssetPaths(repoRoot) {
  return {
    engine: join(repoRoot, "node_modules/@hufe921/canvas-editor/dist/canvas-editor.js"),
    docxPlugin: join(repoRoot, "node_modules/@hufe921/canvas-editor-plugin-docx/dist/docx.js"),
    docxFixture: join(repoRoot, "packages/ui/test/fixtures/office-editor-check.docx"),
    imageFixture: join(repoRoot, "packages/ui/test/fixtures/office-editor-image.png"),
  };
}
