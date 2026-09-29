// 生产构建的隔离 Electron 实例；真实企业微信授权另行验证。
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const endpoint = process.env.ZCODE_E2E_CDP_URL;
assert.ok(endpoint?.startsWith("http://127.0.0.1:"), "必须指定本机隔离测试实例的 CDP 地址");
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()[0]
    .pages()
    .find((candidate) => candidate.url().includes("/packages/desktop/out/renderer/"));
  assert.ok(page, "仅测试当前源码构建，禁止操作已安装应用的数据");
  page.setDefaultTimeout(15000);
  await page.getByTestId("enterprise-login-page").waitFor();
  assert.equal(await page.getByTestId("enterprise-wecom-login").isDisabled(), true);
  assert.match(await page.getByTestId("enterprise-login-page").innerText(), /暂未配置/);
  await page.screenshot({ path: "/tmp/uwork-enterprise-login-desktop.png" });
  await page.getByTestId("enterprise-login-skip").click();
  for (let step = 0; step < 4; step++) {
    const skip = page.getByRole("button", { name: "跳过", exact: true });
    if (!(await skip.isVisible())) break;
    await skip.click();
  }
  const entry = page.getByTestId("enterprise-identity-entry");
  await entry.waitFor();
  await entry.click();
  await page.getByTestId("enterprise-login-page").waitFor();
  await page.keyboard.press("Escape");
  await page.getByTestId("enterprise-login-page").waitFor({ state: "hidden" });
  const mode = page.getByTestId("interface-mode-toggle");
  const previous = await mode.getAttribute("data-interface-mode");
  await mode.click();
  assert.notEqual(await mode.getAttribute("data-interface-mode"), previous);
  await page.screenshot({ path: "/tmp/uwork-enterprise-local-desktop.png" });
  await page.reload();
  await page.getByTestId("enterprise-login-page").waitFor();
  await page.getByTestId("enterprise-login-skip").click();
  await entry.waitFor();
  assert.notEqual(await mode.getAttribute("data-interface-mode"), previous);
  console.log("PASS: Electron startup, skip, reopen, Escape, local mode toggle and reload");
} finally {
  await browser.close();
}
