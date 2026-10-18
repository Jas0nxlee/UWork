// 仅启动当前 dist 产物和临时用户目录，确认安装包默认配置可启用扫码。
import assert from "node:assert/strict";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
import { resolvePackagedDesktopExecutable } from "../scripts/packaged-desktop-executable.mjs";

const [platform, arch] = process.argv.slice(2);
const dist = resolve(import.meta.dirname, "../dist");
const executablePath = resolvePackagedDesktopExecutable(platform, arch, dist);
await access(executablePath);
const data = await mkdtemp(join(tmpdir(), "uwork-packaged-login-"));
let app;
let validationFailed = false;
const stage = (name) => console.log(`[packaged-identity] ${platform}/${arch}: ${name}`);
try {
  const env = { ...process.env, ZCODE_DATA_BASE_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  stage("launching isolated packaged application");
  app = await electron.launch({
    executablePath,
    env,
    args: platform === "linux" ? ["--no-sandbox"] : [],
    timeout: 90000,
  });
  stage("application launched; waiting for first window");
  const page = await app.firstWindow({ timeout: 60000 });
  stage("first window available; waiting for login action");
  page.setDefaultTimeout(60000);
  const button = page.getByTestId("enterprise-wecom-login");
  await button.waitFor();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="enterprise-wecom-login"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  stage("login action ready");
  assert.doesNotMatch(await page.getByTestId("enterprise-login-page").innerText(), /暂未配置/);
  await assert.rejects(access(join(data, ".uwork/v2/enterprise-identity.json")), {
    code: "ENOENT",
  });
  const nativeChildren = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length,
  );
  await button.click();
  stage("login action clicked; waiting for native QR surface");
  await page.getByTestId("enterprise-login-qr-surface").waitFor();
  let nativeOpened = false;
  for (let step = 0; step < 120; step++) {
    nativeOpened = await app.evaluate(
      ({ BrowserWindow }, before) =>
        BrowserWindow.getAllWindows()[0].contentView.children.length > before,
      nativeChildren,
    );
    if (nativeOpened) break;
    await page.waitForTimeout(250);
  }
  assert.ok(nativeOpened, "Packaged Main did not mount the native WeCom view");
  stage("native WeCom view mounted");
  // native view 属于原窗口；开始扫码不应另起窗口或依赖本机配置文件。
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await page.getByTestId("enterprise-login-skip").click();
  await page.getByTestId("enterprise-login-page").waitFor({ state: "hidden" });
  console.log(`PASS: ${platform}/${arch} fresh packaged desktop enables WeCom scanning`);
} catch (error) {
  validationFailed = true;
  // 关闭屏障可能仍在等待 Host；必须先记录真实断言失败，避免 CI 只留下无输出的等待。
  console.error(`[packaged-identity] ${platform}/${arch}: validation failed`, error);
  throw error;
} finally {
  stage("closing isolated application");
  // 已失败的隔离测试不能再被交互式退出确认拦住；仅终止本次启动的进程，原断言仍失败。
  if (validationFailed) app?.process()?.kill("SIGKILL");
  else await app?.close();
  stage("application closed");
  await rm(data, { recursive: true, force: true });
}
