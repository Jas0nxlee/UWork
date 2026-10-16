/**
 * 编辑功能区"全部命令可用性"回归检查（在无头 Chromium 里跑真实引擎）。
 *
 * 为什么要有它：功能区有 45+ 条命令，光靠肉眼点很难保证"全部可用、渲染没坏"；
 * 这里逐条命令跑一遍，检查三件事：
 *   ① 不抛错（引擎没有这个命令 / 参数形态不对都会在这里暴露）；
 *   ② 不吞内容（模型文本量不出现不可解释的大幅下降）；
 *   ③ 渲染没坏（用**截图**判断，而不是读画布像素——GPU 画布在无头环境里 getImageData 取不到数据，
 *      我们踩过这个假象，见 UWork-plugin/specs/office-in-core-research.md）。
 *
 * 命令矩阵从 officeRibbonTabs.ts 里正则抽出来，避免"检查清单与实际功能区脱节"。
 *
 * 用法：node packages/ui/scripts/check-office-editor-commands.mjs
 * 依赖：仓库已装的 playwright-core + ~/Library/Caches/ms-playwright 下的 chromium 无头壳。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../.."); // scripts/ → ui/ → packages/ → 仓库根
const modelPath = join(repoRoot, "packages/ui/src/officeEditor/officeRibbonTabs.ts");
const dispatcherPath = join(repoRoot, "packages/ui/src/officeEditor/officeEditorCommands.ts");

/**
 * 由我们自己的调度器（officeEditorCommands.ts）实现的命令：引擎里当然没有这些名字。
 * 从源码里读 case 标签，避免"脚本里的白名单"与实际调度脱节。
 * 这些命令的**行为**由 check-office-editor-behavior.mjs 断言（那才是真正会出错的地方）。
 */
function dispatcherCommands() {
  const source = readFileSync(dispatcherPath, "utf8");
  return new Set([...source.matchAll(/case "(execute[A-Za-z0-9]+)":/g)].map((match) => match[1]));
}
const fixture = join(repoRoot, "packages/ui/test/fixtures/office-editor-check.docx");

/** 从模型里抽出按钮命令（label/command/args）。 */
function commandsFromModel() {
  const source = readFileSync(modelPath, "utf8");
  const items = [];
  // 用花括号配对扫出 button(...) 的选项对象（参数里含嵌套对象，正则会提前截断）
  for (const start of source.matchAll(/button\(\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*\{/gs)) {
    const label = start[1];
    const command = start[3];
    const openBrace = start.index + start[0].length - 1;
    let depth = 0;
    let endBrace = -1;
    for (let i = openBrace; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          endBrace = i;
          break;
        }
      }
    }
    const rest = endBrace > openBrace ? source.slice(openBrace + 1, endBrace) : "";
    // 参数用方括号配对解析：args 里含嵌套数组（如 valueList: [{...}]），正则会截断。
    let args = [];
    let argsUnparsed = false;
    const argsAt = rest.indexOf("args:");
    if (argsAt >= 0) {
      const open = rest.indexOf("[", argsAt);
      let depth = 0;
      let close = -1;
      for (let i = open; i >= 0 && i < rest.length; i += 1) {
        if (rest[i] === "[") depth += 1;
        else if (rest[i] === "]") {
          depth -= 1;
          if (depth === 0) {
            close = i + 1;
            break;
          }
        }
      }
      if (open >= 0 && close > open) {
        try {
          // 模型里是 JS 字面量（键无引号、可带尾逗号），补引号、去尾逗号后再当 JSON 解析。
          const literal = rest
            .slice(open, close)
            .replaceAll(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
            .replaceAll(/,\s*([\]}])/g, "$1");
          args = JSON.parse(literal);
        } catch {
          // 不能静默当成"无参"：那会把"参数形态不对"变成"调用无参"的假象（真踩过：日期按钮
          // 的 args 因尾逗号解析失败，命令被当无参调用，报的是引擎内部的 TypeError）。
          argsUnparsed = true;
        }
      }
    }
    items.push({ label, command, args, argsUnparsed });
  }
  return items;
}

function writeHarness(dir) {
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><div id="host" style="height:100vh;overflow:auto"></div>
<script type="importmap">{"imports":{"@hufe921/canvas-editor":"/ce/canvas-editor.js"}}</script>
<script type="module">
  import Editor from "/ce/canvas-editor.js";
  import docxPlugin from "/ce/docx.js";
  window.__load = async (url) => {
    const host = document.getElementById("host");
    host.replaceChildren();
    const editor = new Editor(host, { main: [{ value: "" }], pageMode: "paging", scrollContainerSelector: "#host" });
    editor.use(docxPlugin);
    await editor.command.executeImportDocx({ arrayBuffer: await (await fetch(url)).arrayBuffer() });
    // 程序化插入需要游标（引擎在无 range 时直接不插，看起来就像"命令不起作用"）
    editor.command.executeSetRange(0, 0);
    window.__editor = editor;
  };
  window.__text = () => {
    const value = window.__editor.command.getValue?.();
    const data = value?.data?.main ?? value?.main ?? [];
    return data.map((entry) => entry.value ?? "").join("");
  };
  window.__run = (name, args) => {
    const list = Array.isArray(args) ? args : [];
    // 命令不存在时"什么都没发生"最容易被当成通过——这里必须报出来（真机反馈"点了一堆按钮都没用"）。
    if (typeof window.__editor.command[name] !== "function")
      return { missing: true, before: 0, after: 0 };
    const before = window.__text().length;
    const beforeElements = window.__elementCount();
    try {
      window.__editor.command[name](...list);
    } catch (error) {
      return { error: String(error).slice(0, 120) };
    }
    return { before, after: window.__text().length, beforeElements, afterElements: window.__elementCount() };
  };
  window.__elementCount = () => {
    const value = window.__editor.command.getValue?.();
    const data = value?.data?.main ?? value?.main ?? [];
    return data.length;
  };
</script>`,
    "utf8",
  );
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.error("缺少 playwright-core：先 pnpm install");
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), "office-ribbon-check-"));
  writeHarness(dir);
  // 复用仓库里的 canvas-editor 与本检查用的样本文档（样本由 office 插件生成器产出）
  const { cp, mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "ce"), { recursive: true });
  await cp(
    join(repoRoot, "node_modules/@hufe921/canvas-editor/dist/canvas-editor.js"),
    join(dir, "ce/canvas-editor.js"),
  );
  await cp(
    join(repoRoot, "node_modules/@hufe921/canvas-editor-plugin-docx/dist/docx.js"),
    join(dir, "ce/docx.js"),
  );
  await cp(fixture, join(dir, "sample.docx"));

  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = join(dir, path === "/" ? "index.html" : path);
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": file.endsWith(".docx")
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : file.endsWith(".html")
            ? "text/html"
            : "text/javascript",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const port = server.address().port;

  const executablePath = process.env.OFFICE_CHECK_CHROMIUM ?? undefined;
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.evaluate(() => window.__load("/sample.docx"));

  // 参数形态映射：镜像应用层 runRibbon 的处理（图片/超链接/水印/格式刷这些命令收的是对象，不是裸参数）。
  const PARAM_SHAPES = {
    executeImage: [{ value: "", width: 320, height: 240 }],
    executeHyperlink: [
      { url: "https://example.com", valueList: [{ value: "示例链接", size: 16 }] },
    ],
    executeAddWatermark: [
      { data: "检查", color: "#d0d0d0", size: 100, opacity: 0.3, repeat: true },
    ],
    executePainter: [{ isDblclick: false }],
  };
  const commands = commandsFromModel();
  const ownCommands = dispatcherCommands();
  const failures = [];
  // 这些命令的职责就是"往文档里加东西"：插入数为 0 说明参数或命令名不对（真机反馈过"插入控件没反应"）。
  const INSERTING = new Set([
    "executeSeparator",
    "executePageBreak",
    "executeImage",
    "executeHyperlink",
    "executeLatex",
    "executeInsertTable",
    "executeInsertControlByType",
    "executeInsertDateControl",
    "executeInsertCheckboxControl",
    "executeAddWatermark",
  ]);
  // 条数下限：删命令时"少了一条"最难发现（检查只跑它读到的东西）。掉到 40 条以下就说明有命令被删了。
  const MIN_COMMANDS = 40;
  if (commands.length < MIN_COMMANDS)
    failures.push(
      `命令矩阵只剩 ${commands.length} 条（少于 ${MIN_COMMANDS}），像是误删了功能区命令`,
    );
  for (const item of commands) {
    await page.evaluate(() => window.__load("/sample.docx"));
    // 抽取失败必须显式失败：否则"参数没解析出来"会伪装成"无参调用也能过"。
    if (item.argsUnparsed) {
      failures.push(
        `${item.label} [${item.command}] 参数抽取失败（检查脚本解析问题，不是引擎问题）`,
      );
      continue;
    }
    // 我们自己调度的命令在这里跑没有意义（引擎没有这个名字），行为覆盖在 behavior 脚本里
    if (ownCommands.has(item.command)) {
      console.log(
        `--   ${item.label} [${item.command}] 由我们自己的调度器实现，行为检查见 behavior 脚本`,
      );
      continue;
    }
    const shape = PARAM_SHAPES[item.command];
    const result = await page.evaluate(
      ([name, args]) => window.__run(name, args),
      [item.command, shape ?? item.args],
    );
    if (result.missing)
      failures.push(`${item.label} [${item.command}] 引擎没有这条命令（点了不会有反应）`);
    else if (result.error) failures.push(`${item.label} [${item.command}] 抛错：${result.error}`);
    else if (INSERTING.has(item.command) && !(result.afterElements > result.beforeElements))
      failures.push(
        `${item.label} [${item.command}] 什么都没插进去（元素 ${result.beforeElements} → ${result.afterElements}）`,
      );
    else if (result.after < result.before * 0.5)
      failures.push(
        `${item.label} [${item.command}] 内容大幅减少 ${result.before}→${result.after}`,
      );
    else console.log(`ok   ${item.label} [${item.command}] 文本 ${result.before}→${result.after}`);
  }

  // 取值类命令（下拉/样式库）：命令名对、但**取值不在引擎枚举里时会静默无效果**——
  // 真机踩过（标题传 h1 而引擎要 first…sixth）。这里逐个取值断言"元素属性真的被设置成该值"。
  const OPTION_CHECKS = [
    { label: "标题 1", command: "executeTitle", args: ["first"], prop: "level", expect: "first" },
    { label: "标题 3", command: "executeTitle", args: ["third"], prop: "level", expect: "third" },
    { label: "字号 24", command: "executeSize", args: [24], prop: "size", expect: 24 },
    {
      label: "字色红",
      command: "executeColor",
      args: ["rgb(217, 38, 38)"],
      prop: "color",
      expect: "rgb(217, 38, 38)",
    },
    {
      label: "底纹黄",
      command: "executeHighlight",
      args: ["rgb(255, 255, 0)"],
      prop: "highlight",
      expect: "rgb(255, 255, 0)",
    },
    { label: "字体 楷体", command: "executeFont", args: ["楷体"], prop: "font", expect: "楷体" },
  ];
  for (const check of OPTION_CHECKS) {
    await page.evaluate(() => window.__load("/sample.docx"));
    const result = await page.evaluate(
      ([command, args, prop]) => {
        window.__editor.command.executeSetRange(0, 6);
        window.__editor.command[command]?.(...args);
        const value = window.__editor.command.getValue?.();
        const data = value?.data?.main ?? value?.main ?? [];
        const hit = data.find(
          (entry) => entry[prop] !== undefined && entry[prop] !== null && entry[prop] !== "",
        );
        return hit ? hit[prop] : null;
      },
      [check.command, check.args, check.prop],
    );
    if (String(result) === String(check.expect)) {
      console.log(`ok   ${check.label} [${check.command}] → ${check.prop}=${result}`);
    } else {
      failures.push(
        `${check.label} [${check.command}] 取值未生效：期望 ${check.prop}=${check.expect}，实际 ${result}`,
      );
    }
  }

  // 渲染哨兵：真实键盘输入后截图，确认画布确实画出了文字（尺寸远大于空白页）
  await page.evaluate(() => window.__load("/sample.docx"));
  await page.mouse.click(220, 200);
  await page.keyboard.type("回归检查");
  await page.waitForTimeout(400);
  const shot = await page.screenshot();
  if (shot.byteLength < 20000)
    failures.push(`渲染哨兵：截图仅 ${shot.byteLength} 字节，疑似空白画布`);

  await browser.close();
  server.close();

  console.log(`\n共 ${commands.length} 条命令，失败 ${failures.length} 条`);
  for (const failure of failures) console.log("FAIL", failure);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
