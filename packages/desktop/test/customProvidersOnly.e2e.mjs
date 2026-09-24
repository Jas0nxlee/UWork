// 使用隔离数据目录启动生产构建后运行；开发态需同时显式设置 ZCODE_E2E_DEV_ORIGIN。
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const endpoint = process.env.ZCODE_E2E_CDP_URL;
assert.ok(endpoint?.startsWith("http://127.0.0.1:"), "必须显式指定隔离测试实例的本机 CDP 地址");
const browser = await chromium.connectOverCDP(endpoint);
try {
  const devOrigin = process.env.ZCODE_E2E_DEV_ORIGIN;
  const page = browser
    .contexts()[0]
    .pages()
    .find(
      (page) =>
        page.url().includes("/packages/desktop/out/renderer/") ||
        (devOrigin?.startsWith("http://localhost:") && new URL(page.url()).origin === devOrigin),
    );
  assert.ok(page, "仅测试源码构建的隔离窗口，禁止修改已安装应用的数据");
  page.setDefaultTimeout(15000);
  for (
    let step = 0;
    step < 3 && (await page.getByRole("button", { name: "跳过", exact: true }).isVisible());
    step++
  ) {
    await page.getByRole("button", { name: "跳过", exact: true }).click();
  }
  if (!(await page.getByTestId("settings-section-nav-modelProvider").isVisible())) {
    await page.getByTestId("task-settings-button").click();
  }
  await page.getByTestId("settings-section-nav-modelProvider").click();
  const addProvider = page.getByTestId("model-provider-add-provider-button");
  await addProvider.waitFor();
  const forbidden = /BigModel|Start Plan|Z\.ai|开通编程套餐|登录|订阅|升级/;
  assert.doesNotMatch(await page.locator("body").innerText(), forbidden);
  assert.match(await page.locator("body").innerText(), /ucas/);
  await page.getByText("https://lm.ucas.com.cn:15000/v1", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("model-provider-base-url-input").count(), 0);
  await page.getByText("Chat Completions (/chat/completions)", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("model-provider-actions-button").count(), 0);
  assert.equal(await page.getByTestId("model-provider-discover-models-button").count(), 1);
  assert.equal(await page.getByTestId("model-provider-api-key-input").inputValue(), "");
  assert.equal(await page.getByText("1M", { exact: true }).count(), 6);
  for (const model of [
    "ucas-deepseek-flash",
    "ucas-gpt-max",
    "ucas-gpt-mini",
    "ucas-kimi",
    "ucas-glm",
    "ucas-gemini-flash",
  ]) {
    await page.getByText(model, { exact: true }).waitFor();
  }
  await page.screenshot({
    path: process.env.ZCODE_E2E_DEFAULT_SCREENSHOT || "/tmp/zcode-ucas-default-e2e.png",
    animations: "disabled",
  });
  for (let click = 0; click < 10; click++) await addProvider.click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  for (let click = 0; click < 19; click++) await addProvider.click();
  assert.equal(await addProvider.getAttribute("data-settings-create-locked"), "true");
  await addProvider.click();
  assert.equal(await addProvider.getAttribute("data-settings-create-locked"), null);
  assert.equal(await page.getByTestId("model-provider-template-picker").count(), 0);
  await addProvider.click();
  assert.doesNotMatch(await page.locator("body").innerText(), forbidden);
  await page.getByRole("button", { name: "创建自定义供应商", exact: true }).click();
  await page.getByTestId("model-provider-base-url-input").fill("http://127.0.0.1:19488/v1");
  await page.getByTestId("model-provider-api-key-input").fill("e2e-local-key");
  await page.getByTestId("model-provider-api-key-input").blur();
  await page.getByTestId("model-provider-add-model-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("模型 ID", { exact: true }).fill("e2e-model");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByTestId("model-provider-base-url-input").waitFor();
  assert.equal(
    await page.getByTestId("model-provider-base-url-input").inputValue(),
    "http://127.0.0.1:19488/v1",
  );
  assert.equal(
    await page.getByTestId("model-provider-api-key-input").inputValue(),
    "e2e-local-key",
  );
  assert.match(await page.locator("body").innerText(), /e2e-model/);
  assert.doesNotMatch(await page.locator("body").innerText(), forbidden);
  await page.screenshot({
    path: process.env.ZCODE_E2E_SCREENSHOT || "/tmp/zcode-custom-providers-e2e.png",
  });
  console.log(
    "PASS: UCAS default; 20-click add-provider unlock; custom provider, key and model survive refresh",
  );
} finally {
  await browser.close();
}
