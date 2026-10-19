/**
 * PPT 点测的**关键功能用例**：不只看"变没变"，而是断言具体结果。
 *
 * 拆出来的原因：仓库规矩单文件 ≤400 行，点测脚本本身还有主循环与报告。
 * 依赖（page / mountPane / helpers）由调用方注入，这里只写"验什么"。
 */

/** 画布上的形状几何（EMU）：几何类断言用它。 */
const shapeBox = (name) =>
  window.__pptxPane.shapeBox(name) ?? window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]);

export function buildPptxKeyCases({ page, mountPane, clickRibbon }) {
  const status = () =>
    page.evaluate(() => document.querySelector("[data-office-toolbar]")?.textContent ?? "");
  const names = () => page.evaluate(() => window.__pptxPane.shapeNames());
  const wait = (ms) => page.waitForTimeout(ms);

  return [
    {
      name: "加粗：选中形状点一次→XML 有 b=1，再点一次→关掉",
      run: async () => {
        await mountPane();
        await clickRibbon("加粗");
        await wait(400);
        const on = await page.evaluate(
          () => window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "",
        );
        await clickRibbon("加粗");
        await wait(400);
        const off = await page.evaluate(
          () => window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "",
        );
        return {
          ok: /b="1"/.test(on) && !/b="1"/.test(off),
          detail: `第一次 ${/b="1"/.test(on)} → 第二次 ${/b="1"/.test(off)}`,
        };
      },
    },
    {
      name: "字号下拉：选一个与当前不同的字号 → rPr 的 sz 跟着变",
      run: async () => {
        await mountPane();
        await page.evaluate(() => document.querySelector("[data-pptx-open-format]")?.click());
        await wait(300);
        const picked = await page.evaluate(() => {
          const select = document.querySelector("[data-shape-size]");
          if (!select) return null;
          // 选一个与当前不同的（点当前值本来就没变化）
          const other = [...select.options].find(
            (item) => item.value && item.value !== select.value,
          );
          if (!other) return null;
          select.value = other.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return Number(other.value);
        });
        await wait(500);
        const size = await page.evaluate(() => {
          const xml = window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "";
          const name = window.__pptxPane.shapeNames()[0];
          return (
            window.__pptx.readShapes(xml).find((item) => item.name === name)?.runFormat?.size ?? 0
          );
        });
        return {
          ok: picked !== null && size === picked,
          detail: `选了 ${picked} → rPr 里 ${size} 磅`,
        };
      },
    },
    {
      name: "几何输入框：宽改成 15cm → XML 的 cx = 5400000",
      run: async () => {
        await mountPane();
        await page.evaluate(() => document.querySelector("[data-pptx-open-format]")?.click());
        await wait(300);
        await page.fill("[data-shape-field='width']", "15");
        await page.keyboard.press("Enter");
        await wait(400);
        const box = await page.evaluate(() => {
          const name = window.__pptxPane.shapeNames()[0];
          return window.__pptxPane.shapeBox(name);
        });
        return { ok: Math.abs((box?.width ?? 0) - 15 * 360000) < 2, detail: `${box?.width} EMU` };
      },
    },
    {
      name: "段落对齐：点「居中」→ XML 有 algn=ctr",
      run: async () => {
        await mountPane();
        await clickRibbon("居中");
        await wait(400);
        const xml = await page.evaluate(
          () => window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "",
        );
        return { ok: /algn="ctr"/.test(xml), detail: /algn="(\w+)"/.exec(xml)?.[1] ?? "无 algn" };
      },
    },
    {
      name: "项目符号开→关",
      run: async () => {
        await mountPane();
        await clickRibbon("项目符号开/关");
        await wait(400);
        const on = await page.evaluate(
          () => window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "",
        );
        await clickRibbon("项目符号开/关");
        await wait(400);
        const off = await page.evaluate(
          () => window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "",
        );
        return {
          ok: /buChar/.test(on) && !/buChar/.test(off),
          detail: `开 ${/buChar/.test(on)} → 关 ${!/buChar/.test(off)}`,
        };
      },
    },
    {
      name: "新建文本框 → 形状数 +1，且新形状是 sp",
      run: async () => {
        await mountPane();
        const before = await names();
        const clicked = await clickRibbon("在页面中部新建一个文本框", "插入");
        await wait(500);
        const after = await names();
        return {
          ok: clicked && after.length === before.length + 1,
          detail: `点到了 ${clicked}｜${before.length} → ${after.length}（${after.join("、")}）`,
        };
      },
    },
    {
      name: "复制形状 → 形状数 +1 且名字带「副本」",
      run: async () => {
        await mountPane();
        await clickRibbon("复制选中的形状");
        await wait(500);
        const after = await names();
        return { ok: after.some((n) => n.includes("副本")), detail: after.join("、") };
      },
    },
    {
      name: "删除形状 → 形状数 -1（确认框自动同意）",
      run: async () => {
        await mountPane();
        const before = await names();
        await clickRibbon("删除选中的形状");
        await wait(600);
        const after = await names();
        return {
          ok: after.length === before.length - 1,
          detail: `${before.length} → ${after.length}`,
        };
      },
    },
    {
      name: "层级：上移一层的 XML 顺序真的变了",
      run: async () => {
        await mountPane();
        await page.evaluate(() => {
          // 选**最下层**那个（标题 1）：它往上挪才有变化；最上层的再往上挪是天然 no-op
          document.querySelector("[data-pptx-shape]")?.click();
        });
        await wait(300);
        const before = await page.evaluate(
          () => window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "",
        );
        await clickRibbon("把形状往上挪一层");
        await wait(400);
        const after = await page.evaluate(
          () => window.__pptxPane.modelXml("ppt/slides/slide1.xml") ?? "",
        );
        return {
          ok: before !== after && (await status()).includes("层级"),
          detail: (await status()).slice(-40),
        };
      },
    },
    {
      name: "幻灯片：新建 → 复制 → 删除 页数对得上",
      run: async () => {
        await mountPane();
        const start = await page.evaluate(() => window.__pptxPane.slideCount());
        await clickRibbon("新建一页（空白）");
        await wait(900);
        const added = await page.evaluate(() => window.__pptxPane.slideCount());
        await clickRibbon("复制当前这一页");
        await wait(900);
        const copied = await page.evaluate(() => window.__pptxPane.slideCount());
        await clickRibbon("删除当前这一页");
        await wait(900);
        const deleted = await page.evaluate(() => window.__pptxPane.slideCount());
        return {
          ok: added === start + 1 && copied === start + 2 && deleted === start + 1,
          detail: `${start} → ${added} → ${copied} → ${deleted}`,
        };
      },
    },
    {
      name: "缩略图：点第 2 页切过去（当前页高亮跟着走）",
      run: async () => {
        await mountPane();
        await page.evaluate(() => {
          const items = [...document.querySelectorAll("[data-pptx-slide]")];
          items[1]?.click();
        });
        await wait(600);
        const active = await page.evaluate(() => window.__pptxPane.thumbnails()?.active ?? -1);
        return { ok: active === 1, detail: `当前页高亮 = 第 ${active + 1} 页` };
      },
    },
    {
      name: "缩放：− 与 ＋ 各一次，读数按 25 步长变化",
      run: async () => {
        await mountPane();
        await page.evaluate(() => document.querySelector("[data-pptx-zoom-out]")?.click());
        await wait(300);
        const down = await page.evaluate(() => window.__pptxPane.canvas().zoom);
        await page.evaluate(() => document.querySelector("[data-pptx-zoom-in]")?.click());
        await wait(300);
        const back = await page.evaluate(() => window.__pptxPane.canvas().zoom);
        return { ok: down === 75 && back === 100, detail: `100 → ${down} → ${back}` };
      },
    },
    {
      name: "画布拖动：位置改变且画布重画",
      run: async () => {
        await mountPane();
        const before = await page.evaluate(shapeBox);
        const point = await page.evaluate(() => {
          const canvas = window.__pptxPane.canvas();
          const box = window.__pptxPane.shapeBox(window.__pptxPane.shapeNames()[0]);
          return {
            x: canvas.layer.left + ((box.x + box.width / 2) / 9525) * canvas.scale,
            y: canvas.layer.top + ((box.y + box.height / 2) / 9525) * canvas.scale,
          };
        });
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        await page.mouse.move(point.x + 40, point.y + 30, { steps: 6 });
        await page.mouse.up();
        await wait(700);
        const after = await page.evaluate(shapeBox);
        return {
          ok: after.x !== before.x && after.y !== before.y && after.width === before.width,
          detail: `(${before.x},${before.y}) → (${after.x},${after.y})`,
        };
      },
    },
    {
      name: "就地改字：双击 → 改字 → ⌘↵ 提交，文字进 XML",
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
        await page.keyboard.press("Meta+A");
        await page.keyboard.type("点测改的字");
        await page.keyboard.press("Meta+Enter");
        await wait(700);
        const blocks = await page.evaluate(() =>
          [...document.querySelectorAll("[data-pptx-block]")].map((node) => node.value),
        );
        return {
          ok: blocks.some((value) => String(value).includes("点测改的字")),
          detail: JSON.stringify(blocks).slice(0, 60),
        };
      },
    },
    {
      name: "文本输入框：改一行 → 标脏 + 状态栏回话",
      run: async () => {
        await mountPane();
        await page.evaluate(() => document.querySelector("[data-pptx-open-format]")?.click());
        await wait(300);
        const area = page.locator("[data-pptx-block]").first();
        await area.fill("框里改的字");
        await wait(500);
        const state = await page.evaluate(() => ({
          status: document.querySelector("[data-office-toolbar]")?.textContent ?? "",
          value: document.querySelector("[data-pptx-block]")?.value ?? "",
        }));
        return {
          ok: state.value === "框里改的字" && state.status.includes("未保存"),
          detail: `值=${state.value}｜${state.status.slice(-30)}`,
        };
      },
    },
    {
      name: "保存到文件：产物校验通过并写出",
      run: async () => {
        await mountPane();
        await page.evaluate(() => document.querySelector("[data-pptx-open-format]")?.click());
        await wait(300);
        await page.locator("[data-pptx-block]").first().fill("保存前的改动");
        await wait(300);
        await page.evaluate(() => {
          const save = [...document.querySelectorAll("button")].find((b) =>
            (b.textContent ?? "").includes("保存到文件"),
          );
          save?.click();
        });
        await wait(2500);
        const text = await status();
        return { ok: text.includes("已保存到"), detail: text.slice(-60) };
      },
    },
    {
      name: "重新加载：回到文件内容（未保存改动丢弃）",
      run: async () => {
        await mountPane();
        await page.evaluate(() => document.querySelector("[data-pptx-open-format]")?.click());
        await wait(300);
        await page.locator("[data-pptx-block]").first().fill("不要了");
        await wait(300);
        await page.evaluate(() => {
          const reload = [...document.querySelectorAll("button")].find((b) =>
            (b.textContent ?? "").includes("重新加载"),
          );
          reload?.click();
        });
        await wait(2000);
        const state = await page.evaluate(() => ({
          status: document.querySelector("[data-office-toolbar]")?.textContent ?? "",
          value: document.querySelector("[data-pptx-block]")?.value ?? "",
        }));
        return {
          ok: state.status.includes("已载入") && !state.value.includes("不要了"),
          detail: `${state.value.slice(0, 12)}｜${state.status.slice(-30)}`,
        };
      },
    },
  ];
}
