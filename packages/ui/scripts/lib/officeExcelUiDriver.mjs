/**
 * Excel 编辑位检查用的**页面驱动**（点选、跑命令、按用例重挂载）。
 *
 * 抽出来的原因：两处检查都要"像用户那样"拿选区（点网格 + 方向键 + Shift 扩选），
 * 而且这部分踩过的坑不少（程序化 setSelection 不落地、方向键读太早会拿到上一次的地址、
 * 重挂载必须换干净容器），放在一个文件里只写一遍。
 */
/**
 * 引擎把命令的结果提交到 context 是**异步**的（dispatch → React 提交），
 * 所以每条命令之后统一等一小拍，否则断言会偶发读到上一拍的值（加粗/取消合并都栽过）。
 */
const SETTLE_MS = 160;

export function createUiDriver({ page, mountData }) {
  const mount = async () => {
    await page.evaluate((data) => window.__excel.mount({ data }), mountData);
    await page.waitForSelector("#host canvas", { timeout: 20000 });
  };

  const address = () =>
    page.evaluate(() => window.__excel.api().current?.getSelectionCoordinates()?.[0] ?? "");
  const columnOf = (value) => value.replace(/\d+/g, "");
  const rowOf = (value) => Number(value.replace(/\D+/g, ""));

  /** 点一下网格把焦点放进去，再用方向键走到目标格。 */
  const walkTo = async (target) => {
    const box = await page.locator("#host canvas").first().boundingBox();
    await page.mouse.click(Math.round(box.x + 200), Math.round(box.y + 60));
    await page.waitForTimeout(80);
    for (let step = 0; step < 80; step += 1) {
      const current = await address();
      if (current === target) return true;
      const currentColumn = columnOf(current);
      const targetColumn = columnOf(target);
      if (currentColumn !== targetColumn) {
        await page.keyboard.press(currentColumn < targetColumn ? "ArrowRight" : "ArrowLeft");
      } else {
        await page.keyboard.press(rowOf(current) < rowOf(target) ? "ArrowDown" : "ArrowUp");
      }
      // 引擎把选区落到 context 是异步的：读太早会拿到**上一次**的地址，于是同方向连按、
      // 一路顶到边界回不来（断言会变成"改到了 A1"）
      await page.waitForTimeout(60);
    }
    return false;
  };

  /** 从 `from` 扩选到 `to`（Shift + 方向键），拿到一块多格选区。 */
  const selectRange = async (from, to) => {
    const box = await page.locator("#host canvas").first().boundingBox();
    await page.mouse.click(Math.round(box.x + 200), Math.round(box.y + 60));
    if (!(await walkTo(from))) return false;
    await page.keyboard.down("Shift");
    const columnDelta =
      columnOf(from) !== columnOf(to) ? columnOf(to).length - columnOf(from).length : 0;
    for (let step = 0; step < Math.abs(columnDelta); step += 1) {
      await page.keyboard.press(columnDelta > 0 ? "ArrowRight" : "ArrowLeft");
    }
    const rowDelta = rowOf(to) - rowOf(from);
    for (let step = 0; step < Math.abs(rowDelta); step += 1) {
      await page.keyboard.press(rowDelta > 0 ? "ArrowDown" : "ArrowUp");
    }
    await page.keyboard.up("Shift");
    await page.waitForTimeout(60);
    return true;
  };

  /** 每条断言都在**新挂载的实例**上跑：坏状态不互相污染，一条断言只验一件事。 */
  const runCase = async ({ steps = [], from, to, command, args = [], read }) => {
    await mount();
    for (const [name, stepArgs] of steps) {
      await page.evaluate(([n, a]) => window.__excel.run(n, a), [name, stepArgs]);
    }
    const selected = to ? await selectRange(from, to) : await walkTo(from);
    await page.evaluate(([n, a]) => window.__excel.run(n, a), [command, args]);
    await page.waitForTimeout(SETTLE_MS);
    return { selected, value: await page.evaluate(read) };
  };

  return { mount, address, walkTo, selectRange, runCase };
}

/**
 * 跑一遍完整的功能区命令矩阵：把 EXCEL_RIBBON_TABS 里每条命令（含下拉项）都执行一次，
 * 记录"调度器是否接住 / 有没有抛错 / 跑完之后引擎是否还活着"，并带上每一步的表形状
 * （崩在下一条命令上很常见：React 的卸载是异步的，形状能把时间线钉住）。
 */
export async function runRibbonCommandMatrix(page) {
  return page.evaluate(async () => {
    const tabs = window.app.EXCEL_RIBBON_TABS;
    const commands = [];
    for (const tab of tabs) {
      for (const group of tab.groups) {
        for (const item of group.items) {
          if (item.kind === "command")
            commands.push({ command: item.command, args: item.args ?? [] });
          if (item.kind === "select") {
            for (const option of item.options ?? []) {
              commands.push({ command: window.app.optionsCommand(item.title), args: option.args });
            }
          }
        }
      }
    }
    const results = [];
    for (const entry of commands) {
      let error = null;
      let handled = false;
      let message = "";
      try {
        const outcome = await window.__excel.run(entry.command, entry.args);
        handled = outcome.handled;
        message = outcome.messages.join(" / ");
      } catch (thrown) {
        error = String(thrown).slice(0, 160);
      }
      const alive = window.__excel.api().current != null;
      let shape = null;
      if (alive) {
        const engine = window.__excel.api().current;
        const sheet = engine.getSheet?.() ?? engine.getAllSheets()?.[0];
        shape = {
          name: sheet?.name,
          rows: sheet?.data?.length,
          cols: sheet?.data?.[0]?.length,
          selection: engine.getSelectionCoordinates?.(),
        };
      }
      results.push({ ...entry, handled, message, error, alive, shape });
      if (error || !alive) break;
    }
    return { tabs: tabs.map((tab) => ({ id: tab.id, groups: tab.groups.length })), results };
  });
}
