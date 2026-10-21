/**
 * Excel 点测里的**关键功能用例**（不只看"变没变"，而是断言具体结果）。
 *
 * 拆出来的原因：仓库规矩单文件 ≤400 行，而点测脚本本身还有主循环与报告要放。
 * 依赖（page / mountPane / clickByTitle / clickDropdownOption）由调用方注入，这里只写"验什么"。
 */
export function buildKeyCases({ page, mountPane, clickByTitle, clickDropdownOption }) {
  return [
    {
      name: "加粗：点两次是开→关",
      run: async () => {
        await mountPane();
        await page.evaluate(() =>
          window.__officeExcelApi.current.setSelection([{ row: [1, 1], column: [1, 1] }]),
        );
        await page.click('[data-office-ribbon-tab="home"]');
        await clickByTitle("加粗 (⌘B)");
        await page.waitForTimeout(300);
        const on = await page.evaluate(() =>
          window.__officeExcelApi.current.getCellValue(1, 1, { type: "bl" }),
        );
        await clickByTitle("加粗 (⌘B)");
        await page.waitForTimeout(300);
        const off = await page.evaluate(() =>
          window.__officeExcelApi.current.getCellValue(1, 1, { type: "bl" }),
        );
        return { ok: on === 1 && String(off) === "0", detail: `${on} → ${off}` };
      },
    },
    {
      name: "数字格式：下拉选百分比落到格子",
      run: async () => {
        await mountPane();
        await page.evaluate(() =>
          window.__officeExcelApi.current.setSelection([{ row: [1, 1], column: [1, 1] }]),
        );
        await page.click('[data-office-ribbon-tab="home"]');
        await clickByTitle("数字格式");
        await page.waitForSelector("[data-ribbon-dropdown]", { timeout: 5000 });
        await clickDropdownOption("百分比", 4);
        await page.waitForTimeout(300);
        const format = await page.evaluate(() =>
          window.__officeExcelApi.current.getCellValue(1, 1, { type: "ct" }),
        );
        return { ok: format?.fa === "0.00%", detail: JSON.stringify(format) };
      },
    },
    {
      name: "合并居中 → 取消合并",
      run: async () => {
        await mountPane();
        const countMerges = () =>
          page.evaluate(
            () =>
              Object.keys(window.__officeExcelApi.current.getAllSheets()[0].config?.merge ?? {})
                .length,
          );
        const before = await countMerges();
        await page.evaluate(() =>
          window.__officeExcelApi.current.setSelection([{ row: [1, 2], column: [1, 2] }]),
        );
        await page.click('[data-office-ribbon-tab="home"]');
        await clickByTitle("合并并居中");
        await page.waitForTimeout(300);
        const merged = await countMerges();
        await clickByTitle("取消合并");
        await page.waitForTimeout(300);
        const cleared = await countMerges();
        return {
          ok: merged === before + 1 && cleared === before,
          detail: `合并 ${before} → ${merged} → ${cleared} 处（夹具原本 ${before} 处）`,
        };
      },
    },
    {
      name: "插入行 / 删除行：内容整体搬家",
      run: async () => {
        await mountPane();
        await page.evaluate(() =>
          window.__officeExcelApi.current.setSelection([{ row: [1, 1], column: [0, 0] }]),
        );
        await page.click('[data-office-ribbon-tab="home"]');
        await clickByTitle("在上方插入一行");
        await page.waitForTimeout(300);
        const afterInsert = await page.evaluate(() =>
          [0, 1, 2].map((row) =>
            window.__officeExcelApi.current.getCellValue(row, 0, { type: "v" }),
          ),
        );
        await clickByTitle("删除所选行（内容上移）");
        await page.waitForTimeout(300);
        const afterDelete = await page.evaluate(() =>
          [0, 1, 2].map((row) =>
            window.__officeExcelApi.current.getCellValue(row, 0, { type: "v" }),
          ),
        );
        return {
          ok:
            JSON.stringify(afterInsert) === JSON.stringify(["名称", null, "苹果"]) &&
            JSON.stringify(afterDelete) === JSON.stringify(["名称", "苹果", "苹果官网"]),
          detail: `插入后 ${JSON.stringify(afterInsert)}；删除后 ${JSON.stringify(afterDelete)}`,
        };
      },
    },
    {
      name: "整表选中 → 状态栏显示整块范围",
      run: async () => {
        await mountPane();
        await page.click('[data-office-ribbon-tab="home"]');
        await clickByTitle("选中整张表");
        await page.waitForTimeout(300);
        const status = await page.evaluate(
          () => document.querySelector("[data-office-toolbar]")?.textContent ?? "",
        );
        return { ok: /A1:[A-Z]+60/.test(status), detail: status.slice(24, 48) };
      },
    },
    {
      name: "工具栏：保存触发写回、重新加载重新读文件",
      run: async () => {
        await mountPane();
        await page.evaluate(() => {
          // 造一处改动，保证保存有东西可写
          window.__officeExcelApi.current.setCellValue(2, 5, "改动");
        });
        await page.waitForTimeout(300);
        await page.click('button:has-text("保存到文件")');
        await page.waitForTimeout(800);
        const calls = await page.evaluate(() => window.__excelPane.calls().length);
        const callsAfterFirst = calls;
        await page.click('button:has-text("重新加载")');
        await page.waitForTimeout(1500);
        const reloaded = await page.evaluate(
          () =>
            document.querySelector("[data-office-toolbar]")?.textContent?.includes("已载入") ??
            false,
        );
        return {
          ok: callsAfterFirst >= 1 && reloaded,
          detail: `写回 ${callsAfterFirst} 次；重载提示 ${reloaded}`,
        };
      },
    },
    {
      name: "工作表切换：点底部标签能切到第二张表",
      // 已知问题：引擎自己的工作表标签在我们这套宿主里点了不切换（裸引擎同样不切，
      // 与"只给 celldata / 先转成 data 矩阵"无关）。见 specs §2.2c。
      knownIssue: true,
      run: async () => {
        await mountPane();
        // 引擎自己的工作表标签：class 是 luckysheet-sheets-item，按精确文本点
        await page
          .locator("li.luckysheet-sheets-item, .luckysheet-sheets-item")
          .filter({ hasText: /^说明$/ })
          .first()
          .click({ timeout: 8000 });
        await page.waitForTimeout(500);
        const active = await page.evaluate(() => {
          const sheets = window.__officeExcelApi.current.getAllSheets();
          return sheets.find((sheet) => sheet.status === 1)?.name ?? null;
        });
        return { ok: active === "说明", detail: `当前表：${active}` };
      },
    },
  ];
}
