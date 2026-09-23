// 使用隔离 Electron 实例：ZCODE_E2E_CDP_URL=http://127.0.0.1:9229 node packages/desktop/test/uwork.e2e.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
const endpoint = process.env.ZCODE_E2E_CDP_URL;
assert.ok(endpoint?.startsWith("http://127.0.0.1:"));
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  assert.equal(request.url, "/v1/models");
  const authorized = request.headers.authorization === "Bearer e2e-uwork-key";
  response.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
  // 延迟只用于验证加载态，产品代码不使用定时补偿。
  setTimeout(
    () =>
      response.end(
        JSON.stringify(
          authorized
            ? { data: [{ id: "uwork-a" }, { id: "uwork-b" }, { id: "uwork-a" }] }
            : { error: "not authorized" },
        ),
      ),
    250,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes("/packages/desktop/out/renderer/"));
  assert.ok(page, "只允许隔离的源码测试窗口");
  page.setDefaultTimeout(15000);
  const exitGuide = page.getByRole("button", { name: "退出引导", exact: true });
  if (await exitGuide.isVisible()) await exitGuide.click();
  const header = page.getByTestId("workspace-mode-header");
  await header.waitFor();
  assert.match(await header.innerText(), /UWork/);
  const headerBox = await header.boundingBox(),
    taskBox = await page.getByTestId("task-new-button").boundingBox();
  assert.ok(headerBox.y + headerBox.height <= taskBox.y + 1, "字标和模式切换必须位于新建任务上面");
  const toggle = page.getByTestId("interface-mode-toggle");
  assert.equal(await header.getByRole("button").count(), 1);
  const logoBox = await header.getByTestId("uwork-wordmark").boundingBox();
  const toggleBox = await toggle.boundingBox();
  assert.ok(toggleBox.x >= logoBox.x + logoBox.width, "模式按钮位于 UWork 右侧");
  assert.ok(Math.abs(toggleBox.y + toggleBox.height / 2 - logoBox.y - logoBox.height / 2) < 2);
  const initialMode = await toggle.getAttribute("data-interface-mode");
  await toggle.click();
  const switchedMode = initialMode === "office" ? "coding" : "office";
  assert.equal(await toggle.getAttribute("data-interface-mode"), switchedMode);
  assert.equal((await toggle.innerText()).trim(), switchedMode === "office" ? "助理" : "开发");
  await page.reload();
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute("data-interface-mode"), switchedMode);
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await toggle.getAttribute("data-interface-mode"), initialMode);
  await page.getByTestId("workspace-help-menu-trigger").click();
  const menu = page.getByRole("menu");
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["资源管理器"]);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-main-background="UCAS"]').count(), 1);
  await page.screenshot({ path: "/tmp/uwork-main.png", animations: "disabled" });
  await page.getByTestId("task-settings-button").click();
  await page.getByTestId("settings-section-nav-modelProvider").click();
  await page.getByTestId("model-provider-add-provider-button").click();
  await page.getByRole("button", { name: "创建自定义供应商", exact: true }).click();
  await page
    .getByTestId("model-provider-base-url-input")
    .fill(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("combobox").click();
  await page
    .getByRole("option", { name: "Chat Completions (/chat/completions)", exact: true })
    .click();
  await page.getByTestId("model-provider-api-key-input").fill("e2e-uwork-key");
  const button = page.getByTestId("model-provider-discover-models-button");
  await button.click();
  await page.getByRole("button", { name: "获取中…", exact: true }).waitFor();
  const result = page.getByTestId("model-provider-discovery-result");
  await result.filter({ hasText: "新增 2 个" }).waitFor();
  assert.equal(requests, 1);
  assert.match(
    await page.locator('[data-model-provider-split-panel="true"]').innerText(),
    /uwork-a/,
  );
  await button.click();
  await result.filter({ hasText: "新增 0 个" }).waitFor();
  assert.equal(requests, 2);
  await page.getByTestId("model-provider-api-key-input").fill("invalid");
  await button.click();
  await page.getByTestId("model-provider-discovery-error").filter({ hasText: "401" }).waitFor();
  assert.equal(requests, 3);
  assert.match(
    await page.locator('[data-model-provider-split-panel="true"]').innerText(),
    /uwork-b/,
  );
  await page.getByTestId("model-provider-api-key-input").fill("e2e-uwork-key");
  await button.click();
  await result.filter({ hasText: "已有 2 个" }).waitFor();
  // 导入会提升 Registry revision；编辑必须使用打开弹窗时的真实版本，而非默认 0。
  const editModel = page.getByRole("button", { name: "编辑模型配置", exact: true }).first();
  for (const contextWindow of ["1000000", "512000"]) {
    await editModel.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("上下文窗口", { exact: true }).fill(contextWindow);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    try {
      await dialog.waitFor({ state: "hidden", timeout: 5000 });
    } catch (error) {
      console.error("Model edit failed:", await dialog.innerText());
      throw error;
    }
    await editModel.click();
    assert.equal(
      await dialog.getByLabel("上下文窗口", { exact: true }).inputValue(),
      contextWindow,
    );
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
  }
  await page.screenshot({ path: "/tmp/uwork-model-discovery.png" });
  console.log(
    "PASS: SVG wordmark and modes above New Task; persistence; discovery loading, import, deduplication, 401 preservation and post-discovery parameter edits",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
