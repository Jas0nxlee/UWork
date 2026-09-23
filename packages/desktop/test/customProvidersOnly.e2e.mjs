// 使用隔离数据目录启动生产构建后运行：ZCODE_E2E_CDP_URL=http://127.0.0.1:9229 node packages/desktop/test/customProvidersOnly.e2e.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const endpoint = process.env.ZCODE_E2E_CDP_URL;
assert.ok(endpoint?.startsWith("http://127.0.0.1:"), "必须显式指定隔离测试实例的本机 CDP 地址");
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes("/packages/desktop/out/renderer/"));
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
  await page.getByTestId("model-provider-add-provider-button").waitFor();
  const forbidden = /BigModel|Start Plan|Z\.ai|开通编程套餐|登录|订阅|升级/;
  assert.doesNotMatch(await page.locator("body").innerText(), forbidden);
  await page.getByTestId("model-provider-add-provider-button").click();
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
  console.log("PASS: no login/builtin providers; custom provider, key and model survive refresh");
} finally {
  await browser.close();
}
