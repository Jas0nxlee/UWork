/**
 * PPT 编辑位的**全按键点测**：功能区每个按钮/每个下拉项、右栏每个控件、缩略图面板、
 * 画布上的缩放条与形状手柄——**在真编辑位里逐个点一遍**，判定"不报错 + 有反应"。
 *
 * 为什么单独一条：命令矩阵（`officePptxRibbonCases`）证明的是"调度器认识这条命令"，
 * 这里证明的是"用户点得到、点了有反应"。真机上反复出现的正是这一类（"点了没反应"、
 * "折叠菜单点不着"），调度器级检查看不出来。
 *
 * 判定口径（每条）：
 *   ① 点完不能有页面错误/控制台错误；
 *   ② 编辑位还活着（画布仍能读状态、`__pptxPane` 还在）；
 *   ③ **指纹至少变了一样**（状态栏 / 形状列表 / 页数 / 缩放 / 选中 / 文本 / 脏标记 / 画布图片数）。
 * 少数天然"点了不变"的控件（适应窗口时再点适应、已全选时再全选）在清单里标 `mayNoop`。
 */
/**
 * **已知问题**（照实打印、不让门禁变红——与 Excel 点测同款做法）。
 * 这些都是点测当场查出来、还没修的，写在这里就能一直看见；修好一条就删一条。
 */
const KNOWN_ISSUES = [
  // 目前为空：第一轮查出的 6 条已全部收掉（4 条是用例前提、1 条是右栏按钮写死"设为开"、
  // 1 条是"点功能区那个按钮"没走到命令——用例改成按形状自己的 rPr 判开关后通过）。
  // 以后再加条目就写在这里，照实打印、不染红门禁。
];

/** 把 report.check 包一层"已知问题不算失败"的过滤器（点测与关键断言共用）。 */
export function makePptxKnownIssueCheck(report) {
  const { check: rawCheck } = report;
  const known = [];
  const check = (ok, message) => {
    if (!ok && KNOWN_ISSUES.some((item) => message.includes(item))) {
      known.push(message);
      console.log(`⚠ 已知问题（不计失败）：${message}`);
      return;
    }
    if (ok) {
      rawCheck(true, message);
      return;
    }
    rawCheck(ok, message);
  };
  return { check, known };
}

export async function runPptxButtonCases({ page, report, clickRibbon, mountPane }) {
  const { stage } = report;
  const { check, known } = makePptxKnownIssueCheck(report);
  const wait = (ms) => page.waitForTimeout(ms);
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error.message).slice(0, 120)}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 120)}`);
  });

  /** 界面指纹：任何"有反应"的操作都会动到其中至少一项。 */
  /** 选中形状当前的首个 run 格式（文字类按钮看"有没有翻转"）。 */
  const shapeFormat = () =>
    page.evaluate(() => {
      const xml = window.__pptxPane?.modelXml?.("ppt/slides/slide1.xml") ?? "";
      const name = window.__pptxPane?.shapeNames?.()?.[0];
      const shape = window.__pptx.readShapes(xml).find((item) => item.name === name);
      return shape?.runFormat ?? {};
    });

  const fingerprint = () =>
    page.evaluate(() => {
      const pane = document.querySelector("[data-pptx-task-pane]");
      const canvas = window.__pptxPane?.canvas?.() ?? null;
      const host = document.querySelector("[data-pptx-canvas-host]");
      return {
        status: document.querySelector("[data-office-toolbar]")?.textContent?.slice(-70) ?? "",
        shapes: window.__pptxPane?.shapeNames?.().join("|") ?? "",
        slides: window.__pptxPane?.slideCount?.() ?? 0,
        zoom: canvas?.zoom ?? 0,
        selected: canvas?.selected ?? "",
        block: document.querySelector("[data-pptx-block]")?.value?.slice(0, 20) ?? "",
        paneOpen: Boolean(pane),
        thumbs: document.querySelectorAll("[data-pptx-slide]").length,
        images: host?.querySelectorAll("img").length ?? 0,
        editor: Boolean(document.querySelector("[data-pptx-text-editor]")),
        dialog: Boolean(document.querySelector("[data-office-ribbon-prompt-file]")),
        // 表格网格/其它下拉面板"开着"本身就是有反应（点了不改文档，但界面变了）
        tableGrid: Boolean(document.querySelector("[data-office-ribbon-table-grid]")),
        dropdown: Boolean(document.querySelector("[data-ribbon-dropdown]")),
      };
    });
  const changed = (before, after) => Object.keys(before).some((key) => before[key] !== after[key]);

  /**
   * 功能区里的一个控件：**按真实路径点**——先切标签，再（必要时）展开 `»` 面板或打开它所在的下拉，
   * 最后点。早先只按 title 找，字体选项与折叠分组根本不在 DOM 里，报"点了 null"。
   */
  const clickRibbonControl = async (tabLabel, title) => {
    await page.evaluate((label) => {
      const tab = [...document.querySelectorAll("[data-office-ribbon-tab]")].find(
        (node) => (node.textContent ?? "").trim() === label,
      );
      tab?.click();
    }, tabLabel);
    await wait(220);
    const lookup = (wanted) =>
      page.evaluate((title2) => {
        const node = [...document.querySelectorAll("button")].find(
          (item) => (item.getAttribute("title") ?? "") === title2,
        );
        if (!node) return null;
        node.click();
        return `${node.tagName}「${(node.textContent ?? "").trim().slice(0, 10)}」`;
      }, wanted);
    const direct = await lookup(title);
    if (direct) return direct;
    // ① 收进「»」面板的分组
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const toggled = await page.evaluate(() => {
        const more = document.querySelector("[data-office-ribbon-more]");
        if (!more) return false;
        more.click();
        return true;
      });
      if (!toggled) break;
      await wait(250);
      const found = await lookup(title);
      if (found) return found;
    }
    // ② 下拉里的选项（字体/字号/颜色）：先点开那个下拉，再点同名的选项
    for (const trigger of ["字体", "字号", "文字颜色"]) {
      const opened = await page.evaluate((wanted) => {
        const node = [...document.querySelectorAll("button")].find(
          (item) => (item.getAttribute("title") ?? "") === wanted,
        );
        if (!node) return false;
        node.click();
        return true;
      }, trigger);
      if (!opened) continue;
      await wait(250);
      const picked = await page.evaluate((wanted) => {
        const node = [...document.querySelectorAll("[data-ribbon-dropdown] button")].find(
          (item) => (item.textContent ?? "").trim() === wanted,
        );
        if (!node) return null;
        node.click();
        return `选项「${(node.textContent ?? "").trim().slice(0, 10)}」`;
      }, title);
      await page.keyboard.press("Escape").catch(() => {});
      if (picked) return picked;
    }
    return null;
  };

  /** 点一个控件（按 title / 文本 / 选择器），前后比指纹 + 收页面错误。 */
  const clickControl = async (control) => {
    errors.length = 0;
    const before = await fingerprint();
    let clickedTargetFallback = "";
    const clickedTarget = await page.evaluate((spec) => {
      const candidates = [...document.querySelectorAll("button, select, [data-pptx-shape], input")];
      const node = candidates.find((item) => {
        if (spec.selector) return item.matches(spec.selector);
        if (spec.title) return (item.getAttribute("title") ?? "") === spec.title;
        return (item.textContent ?? "").trim() === spec.text;
      });
      if (!node) return null;
      const describe = `${node.tagName}[${(node.getAttribute("class") ?? "").slice(0, 24)}]「${(
        node.textContent ?? ""
      )
        .trim()
        .slice(
          0,
          12,
        )}」inRibbon=${Boolean(node.closest("[data-office-ribbon-layout]"))}inPane=${Boolean(
        node.closest("[data-pptx-task-pane]"),
      )}disabled=${Boolean(node.disabled)}`;
      node.click();
      return describe;
    }, control.spec);
    const clicked = clickedTarget !== null || Boolean(clickedTargetFallback);
    if (!clicked && control.spec.selector) {
      // 选择器找不到时退回 title/文本
      const fallback = { ...control.spec, selector: undefined };
      const again = await page.evaluate((spec) => {
        const candidates = [...document.querySelectorAll("button, select, input")];
        const node = candidates.find((item) =>
          spec.title
            ? (item.getAttribute("title") ?? "") === spec.title
            : (item.textContent ?? "").trim() === spec.text,
        );
        node?.click();
        return Boolean(node);
      }, fallback);
      if (!again) return { clicked: false, reason: "控件没找到" };
      clickedTargetFallback = "（退回 title/文本匹配）";
    }
    await wait(control.wait ?? 500);
    const after = await fingerprint();
    const alive = await page.evaluate(() => Boolean(window.__pptxPane?.canvas?.()));
    return {
      clicked: true,
      target: clickedTarget,
      alive,
      moved: changed(before, after),
      errors: [...errors],
      detail: `点了 ${clickedTarget}｜${before.shapes.slice(0, 16)}→${after.shapes.slice(0, 16)}｜页 ${before.slides}→${after.slides}｜${after.status.slice(-30)}`,
    };
  };

  stage("全按键点测（功能区）");
  await mountPane();
  const ribbonControls = await page.evaluate(async () => {
    // 把三个标签下所有按钮的 title 与分组都抓出来（收进 » 的先展开）
    const out = [];
    for (const tab of [...document.querySelectorAll("[data-office-ribbon-tab]")]) {
      tab.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const collect = (root) =>
        [...root.querySelectorAll("button")].map((node) => node.getAttribute("title") ?? "");
      let titles = collect(document.querySelector("[data-office-ribbon-groups]") ?? document);
      const more = document.querySelector("[data-office-ribbon-more]");
      if (more) {
        more.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        titles = titles.concat(
          [...document.querySelectorAll("[data-ribbon-dropdown] button")].map(
            (node) => node.getAttribute("title") ?? "",
          ),
        );
        more.click();
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      out.push({
        tab: (tab.textContent ?? "").trim(),
        titles: titles.filter((title) => title && title !== "更多分组"),
      });
    }
    return out;
  });
  const ribbonTotal = ribbonControls.reduce((sum, entry) => sum + entry.titles.length, 0);
  check(
    ribbonTotal >= 25,
    `功能区抓出 ${ribbonTotal} 个按钮（${ribbonControls.map((e) => `${e.tab}:${e.titles.length}`).join(" ")}）`,
  );

  // 逐个点：先选中一个形状（大多数命令要选中对象），再点按钮
  for (const entry of ribbonControls) {
    for (const title of entry.titles) {
      await mountPane();
      await page.evaluate(() => {
        const chip = document.querySelector("[data-pptx-shape]");
        if (chip && !document.querySelector("[data-pptx-task-pane]")) {
          document.querySelector("[data-pptx-open-format]")?.click();
        }
      });
      await wait(250);
      errors.length = 0;
      if (title.includes("挪一层")) {
        // 层级：**上移选最下层那个**、下移选最上层那个（选反了就是天然 no-op）
        await page.evaluate((wantTop) => {
          const chips = [...document.querySelectorAll("[data-pptx-shape]")];
          const target = wantTop ? chips[chips.length - 1] : chips[0];
          target?.click();
        }, title.includes("往下"));
        await wait(250);
      }
      if (title === "按可用宽度显示" || title === "按 100% 显示") {
        // 这两个是"回到 100%"：先经预设下拉设成 150%，否则当前就是 100% → 点了当然没变化
        await page.evaluate(() => {
          const select = document.querySelector("[data-pptx-zoom-presets]");
          if (!select) return;
          select.value = "150";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await wait(400);
      }
      const before = await fingerprint();
      const target = await clickRibbonControl(entry.tab, title);
      await wait(700);
      const after = await fingerprint();
      const result = {
        clicked: target !== null,
        target,
        moved: changed(before, after),
        errors: [...errors],
        alive: await page.evaluate(() => Boolean(window.__pptxPane?.canvas?.())),
        detail: `点了 ${target ?? "null"}｜页 ${before.slides}→${after.slides}｜${after.status.slice(-30)}`,
      };
      // 纯数字是字号选项：与当前字号相同时点了当然没变化（字号生效由"关键功能"里的具体断言管）
      const mayNoop = /^\d+$/.test(title);
      if (title.includes("图片") || title.includes("表格")) {
        // 点了会开对话框/网格：验完收起来，免得影响下一条
        await page.keyboard.press("Escape").catch(() => {});
      }
      check(
        result.clicked && result.alive && result.errors.length === 0 && (result.moved || mayNoop),
        `${entry.tab} › ${title}${result.moved ? "" : mayNoop ? "（点的是当前值，允许无变化）" : `（点了没有任何变化：${result.detail}）`}${result.errors.length ? `｜${result.errors[0]}` : ""}`,
      );
    }
  }

  stage("右栏控件");
  const paneControls = [
    {
      name: "设置形状格式（打开窗格）",
      spec: { title: "打开右侧「设置形状格式」窗格" },
      startClosed: true,
    },
    { name: "收起窗格 ✕", spec: { title: "收起窗格（把画布让出来）" } },
    { name: "＋ 文本框", spec: { text: "＋ 文本框" } },
    { name: "层级：上移一层", spec: { text: "上移一层" } },
    { name: "层级：下移一层", spec: { text: "下移一层" } },
    { name: "复制形状", spec: { text: "复制形状" } },
    { name: "删除形状", spec: { text: "删除形状" }, acceptDialog: true },
    { name: "文字：加粗", spec: { text: "加粗" } },
    { name: "文字：斜体", spec: { text: "斜体" } },
    { name: "文字：下划线", spec: { text: "下划线" } },
    { name: "文字：删除线", spec: { text: "删除线" } },
    { name: "段落：左", spec: { text: "左" } },
    { name: "段落：居中", spec: { text: "居中" } },
    { name: "段落：右", spec: { text: "右" } },
    { name: "段落：两端", spec: { text: "两端" } },
    { name: "段落：项目符号", spec: { text: "项目符号" } },
    { name: "段落：去符号", spec: { text: "去符号" } },
  ];
  for (const control of paneControls) {
    await mountPane();
    if (control.startClosed) {
      // 先确保窗格是**关着**的，否则"打开窗格"点了当然没变化
      await page.evaluate(() => document.querySelector("[data-pptx-close-format]")?.click());
      await wait(300);
    } else {
      await page.evaluate(() => {
        document.querySelector("[data-pptx-open-format]")?.click();
      });
      await page.evaluate((useTop) => {
        // 层级：**上移选最下层那个**、下移选最上层那个（选反了就是天然 no-op）
        const chips = [...document.querySelectorAll("[data-pptx-shape]")];
        const target = useTop ? chips[chips.length - 1] : chips[0];
        target?.click();
      }, control.name.includes("下移"));
      await wait(350);
    }
    const toggles = {
      "文字：加粗": "bold",
      "文字：斜体": "italic",
      "文字：下划线": "underline",
      "文字：删除线": "strike",
    };
    const flag = toggles[control.name];
    if (flag) {
      // 文字格式是**开关**：点之前是开→点完该是关，反之亦然（点"当前已是的值"本来就没变化）
      const beforeFlag = await shapeFormat();
      await clickControl({ spec: control.spec, wait: 700 });
      const afterFlag = await shapeFormat();
      check(
        Boolean(beforeFlag[flag]) !== Boolean(afterFlag[flag]),
        `右栏 › ${control.name}（${flag}：${Boolean(beforeFlag[flag])} → ${Boolean(afterFlag[flag])}）`,
      );
      continue;
    }
    const result = await clickControl({ spec: control.spec, wait: 700 });
    check(
      result.clicked && result.alive && result.errors.length === 0 && result.moved,
      `右栏 › ${control.name}${result.moved ? "" : `（点了没有任何变化：${result.detail}）`}${result.errors.length ? `｜${result.errors[0]}` : ""}`,
    );
  }

  stage("下拉项与输入框");
  const selectControls = [
    { name: "字号下拉：选一个与当前不同的字号", selector: "[data-shape-size]", option: null },
    { name: "颜色下拉：选一个颜色", selector: "[data-shape-color]", option: null },
    { name: "缩放预设：选 150%", selector: "[data-pptx-zoom-presets]", option: "150" },
  ];
  for (const control of selectControls) {
    await mountPane();
    await page.evaluate(() => {
      document.querySelector("[data-pptx-open-format]")?.click();
      document.querySelector("[data-pptx-shape]")?.click();
    });
    await wait(350);
    errors.length = 0;
    const before = await fingerprint();
    const picked = await page.evaluate(({ selector, option }) => {
      const select = document.querySelector(selector);
      if (!select) return false;
      if (option === null && selector === "[data-shape-size]") {
        // 字号：挑一个与当前值不同的（点当前值本来就没变化）
        const other = [...select.options].find((item) => item.value && item.value !== select.value);
        if (!other) return false;
        select.value = other.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      const target = option
        ? [...select.options].find((item) => item.value === option)
        : // 颜色：挑第一个非空且不等于当前值的（面板里存的是不带 # 的十六进制，"默认"是空值）
          [...select.options].find((item) => item.value !== "" && item.value !== select.value);
      if (!target) return false;
      select.value = target.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, control);
    await wait(600);
    const after = await fingerprint();
    check(
      picked && changed(before, after) && errors.length === 0,
      `下拉 › ${control.name}${changed(before, after) ? "" : "（选了没有任何变化）"}${errors.length ? `｜${errors[0]}` : ""}`,
    );
  }

  // 位置/大小四个输入框：都填一次并回车
  for (const field of ["x", "y", "width", "height"]) {
    await mountPane();
    await page.evaluate(() => {
      document.querySelector("[data-pptx-open-format]")?.click();
      document.querySelector("[data-pptx-shape]")?.click();
    });
    await wait(350);
    errors.length = 0;
    const before = await page.evaluate(() => {
      const name = window.__pptxPane.shapeNames()[0];
      return window.__pptxPane.shapeBox(name);
    });
    await page.fill(`[data-shape-field='${field}']`, field === "x" || field === "y" ? "1.5" : "9");
    await page.keyboard.press("Enter");
    await wait(500);
    const after = await page.evaluate(() => {
      const name = window.__pptxPane.shapeNames()[0];
      return window.__pptxPane.shapeBox(name);
    });
    check(
      before && after && before[field] !== after[field] && errors.length === 0,
      `输入框 › ${field}：${before?.[field]} → ${after?.[field]}${errors.length ? `｜${errors[0]}` : ""}`,
    );
  }

  stage("缩略图面板与画布");
  await mountPane();
  await page.evaluate(() => {
    // 上移/下移在第 1 页是天然 no-op（没有上一页）：先切到第 2 页
    [...document.querySelectorAll("[data-pptx-slide]")][1]?.click();
  });
  await wait(700);
  const thumbControls = [
    { name: "＋ 新页", spec: { selector: "[data-slide-add]" }, wait: 1200 },
    { name: "复制这一页", spec: { selector: "[data-slide-duplicate]" }, wait: 1200 },
    { name: "上移一页", spec: { selector: "[data-slide-up]" }, wait: 1200 },
    { name: "下移一页", spec: { selector: "[data-slide-down]" }, wait: 1200 },
    {
      name: "删除这一页",
      spec: { selector: "[data-slide-delete]" },
      wait: 1200,
      acceptDialog: true,
    },
    { name: "收起缩略图", spec: { selector: "[data-pptx-thumbs-close]" }, wait: 500 },
    { name: "展开缩略图", spec: { selector: "[data-pptx-thumbs-open]" }, wait: 500 },
  ];
  for (const control of thumbControls) {
    errors.length = 0;
    const before = await fingerprint();
    await page.evaluate(
      (selector) => document.querySelector(selector)?.click(),
      control.spec.selector,
    );
    await wait(control.wait ?? 600);
    const after = await fingerprint();
    check(
      changed(before, after) && errors.length === 0,
      `缩略图面板 › ${control.name}${changed(before, after) ? "" : `（点了没有任何变化：${JSON.stringify(after).slice(0, 60)}）`}${errors.length ? `｜${errors[0]}` : ""}`,
    );
  }
  // 逐页点缩略图（切页）
  const pageCount = await page.evaluate(
    () => document.querySelectorAll("[data-pptx-slide]").length,
  );
  for (let index = 0; index < pageCount; index += 1) {
    errors.length = 0;
    await page.evaluate((target) => {
      [...document.querySelectorAll("[data-pptx-slide]")][target]?.click();
    }, index);
    await wait(700);
    const active = await page.evaluate(() => window.__pptxPane.thumbnails()?.active ?? -1);
    check(
      active === index && errors.length === 0,
      `缩略图 › 点第 ${index + 1} 页切过去（高亮 ${active + 1}）`,
    );
  }

  await page.evaluate(() => {
    document.querySelector("[data-pptx-zoom-in]")?.click();
    document.querySelector("[data-pptx-close-format]")?.click();
  });
  await wait(500);
  const canvasControls = [
    { name: "缩放 −", selector: "[data-pptx-zoom-out]", wait: 400 },
    { name: "缩放 ＋", selector: "[data-pptx-zoom-in]", wait: 400 },
    { name: "适应窗口（从放大状态回到 100%）", selector: "[data-pptx-zoom-fit]", wait: 500 },
    { name: "设置形状格式（窗格关着时打开）", selector: "[data-pptx-open-format]", wait: 500 },
  ];
  for (const control of canvasControls) {
    errors.length = 0;
    const before = await fingerprint();
    await page.evaluate((selector) => document.querySelector(selector)?.click(), control.selector);
    await wait(control.wait);
    const after = await fingerprint();
    check(
      changed(before, after) && errors.length === 0,
      `画布 › ${control.name}${changed(before, after) ? "" : "（点了没有任何变化）"}${errors.length ? `｜${errors[0]}` : ""}`,
    );
  }

  if (known.length > 0) {
    console.log(
      `\n已知问题 ${known.length} 条（见 specs/office-editors-triad.md 的"全按键点测"一节）`,
    );
  }

  stage("画布交互（拖动 / 手柄 / 双击 / Ctrl+滚轮）");
  await mountPane();
  const interactions = [
    {
      name: "拖动手柄（四角缩放的 se）",
      run: async () => {
        await page.evaluate(() => {
          document.querySelector("[data-pptx-open-format]")?.click();
          document.querySelector("[data-pptx-shape]")?.click();
        });
        await wait(400);
        const before = await page.evaluate(() => {
          const name = window.__pptxPane.shapeNames()[0];
          return window.__pptxPane.shapeBox(name);
        });
        const handle = await page.evaluate(() => {
          const node = document.querySelector("[data-pptx-canvas-handle='se']");
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        if (!handle) return { ok: false, detail: "没找到 se 手柄" };
        await page.mouse.move(handle.x, handle.y);
        await page.mouse.down();
        await page.mouse.move(handle.x + 30, handle.y + 24, { steps: 5 });
        await page.mouse.up();
        await wait(700);
        const after = await page.evaluate(() => {
          const name = window.__pptxPane.shapeNames()[0];
          return window.__pptxPane.shapeBox(name);
        });
        return {
          ok: after.width > before.width && after.height > before.height,
          detail: `${before.width}×${before.height} → ${after.width}×${after.height}`,
        };
      },
    },
    {
      name: "Ctrl+滚轮缩放（以指针为中心）",
      run: async () => {
        await mountPane();
        const center = await page.evaluate(() => {
          const canvas = window.__pptxPane.canvas();
          return {
            x: canvas.layer.left + canvas.layer.width / 2,
            y: canvas.layer.top + canvas.layer.height / 2,
            zoom: canvas.zoom,
          };
        });
        await page.mouse.move(center.x, center.y);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -200);
        await page.keyboard.up("Control");
        await wait(600);
        const zoom = await page.evaluate(() => window.__pptxPane.canvas().zoom);
        return { ok: zoom > center.zoom, detail: `${center.zoom}% → ${zoom}%` };
      },
    },
    {
      name: "双击就地改字 → Esc 放弃（文字不变）",
      run: async () => {
        await mountPane();
        const point = await page.evaluate(() => {
          const canvas = window.__pptxPane.canvas();
          const box = window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]);
          return {
            x: canvas.layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
            y: canvas.layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
          };
        });
        await page.mouse.dblclick(point.x, point.y);
        await wait(500);
        const opened = await page.evaluate(() =>
          Boolean(document.querySelector("[data-pptx-text-editor]")),
        );
        await page.keyboard.press("Escape");
        await wait(400);
        const closed = await page.evaluate(() =>
          Boolean(document.querySelector("[data-pptx-text-editor]")),
        );
        return { ok: opened && !closed, detail: `打开 ${opened} → Esc 后 ${closed}` };
      },
    },
  ];
  for (const interaction of interactions) {
    const result = await interaction.run();
    check(result.ok, `画布 › ${interaction.name}（${result.detail}）`);
  }
}
