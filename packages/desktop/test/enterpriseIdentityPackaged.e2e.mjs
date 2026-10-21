// 以 Chromium CDP 验证未改写的正式包，保持 Windows 的 Node Inspector fuse 关闭。
import assert from "node:assert/strict";
import { mkdtemp, access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePackagedDesktopExecutable } from "../scripts/packaged-desktop-executable.mjs";
import { launchPackagedDesktopCdp } from "../scripts/packaged-desktop-cdp.mjs";

const [platform, arch] = process.argv.slice(2);
const { version } = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);
const executablePath = resolvePackagedDesktopExecutable(
  platform,
  arch,
  resolve(import.meta.dirname, "../dist"),
);
await access(executablePath);
const data = await mkdtemp(join(tmpdir(), "uwork-packaged-login-"));
const stage = (name) => console.log(`[packaged-identity] ${platform}/${arch}: ${name}`);
const mainPages = (browser) =>
  browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => /\/renderer\/index\.html(?:\?|$)/.test(page.url()));
const authHosts = new Set([
  "login.work.weixin.qq.com",
  "open.work.weixin.qq.com",
  "open.weixin.qq.com",
  "work.weixin.qq.com",
]);
const isAuthorizationTarget = (target) => {
  if (target.type !== "page") return false;
  if (target.url === "about:blank") return true;
  try {
    return authHosts.has(new URL(target.url).hostname);
  } catch {
    return false;
  }
};
let app;
try {
  const env = {
    ...process.env,
    UWORK_DATA_BASE_DIR: data,
    ZCODE_DATA_BASE_DIR: data,
    ZCODE_STORAGE_DIR: join(data, ".uwork"),
    ZCODE_DESKTOP_HOME_DIR: data,
    ZCODE_DESKTOP_USER_DATA_DIR: join(data, "userData"),
    ZCODE_DESKTOP_SESSION_DATA_DIR: join(data, "sessionData"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  stage("launching unmodified production executable without Node Inspector");
  app = await launchPackagedDesktopCdp({ executablePath, env, platform });
  stage("Chromium CDP connected; waiting for main Renderer");
  const deadline = Date.now() + 60_000;
  while (mainPages(app.browser).length === 0 && Date.now() < deadline) await delay(100);
  assert.equal(mainPages(app.browser).length, 1, "Expected one packaged UWork main Renderer");
  const page = mainPages(app.browser)[0];
  page.setDefaultTimeout(60_000);
  const button = page.getByTestId("enterprise-wecom-login");
  await button.waitFor();
  // 只检查源码夹具会漏掉构建常量丢失或旧资源混包；正式包必须显示本次根版本。
  const versionFooter = page.getByTestId("enterprise-login-version");
  assert.equal(await versionFooter.isVisible(), true);
  assert.ok(
    [`客户端版本 v${version}`, `Client version v${version}`].includes(
      await versionFooter.innerText(),
    ),
    "Packaged login footer does not match this release version",
  );
  stage(`client version ${version} verified in the packaged Renderer`);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="enterprise-wecom-login"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  stage("login action ready");
  assert.doesNotMatch(await page.getByTestId("enterprise-login-page").innerText(), /暂未配置/);
  await assert.rejects(access(join(data, ".uwork/v2/enterprise-identity.json")), {
    code: "ENOENT",
  });
  const cdp = await app.browser.newBrowserCDPSession();
  const before = new Set(
    (await cdp.send("Target.getTargets")).targetInfos.map((target) => target.targetId),
  );
  await button.click();
  await page.getByTestId("enterprise-login-qr-surface").waitFor();
  let nativeTargets = [];
  for (let step = 0; step < 120; step++) {
    nativeTargets = (await cdp.send("Target.getTargets")).targetInfos.filter(
      (target) => !before.has(target.targetId) && isAuthorizationTarget(target),
    );
    if (nativeTargets.length) break;
    await delay(250);
  }
  assert.equal(
    nativeTargets.length,
    1,
    "Packaged Main did not create exactly one native authorization target",
  );
  assert.equal(
    mainPages(app.browser).length,
    1,
    "Login must retain the original UWork main Renderer",
  );
  stage("native authorization target mounted; validating cancellation");
  await page.getByTestId("enterprise-login-skip").click();
  await page.getByTestId("enterprise-login-page").waitFor({ state: "hidden" });
  const nativeIds = new Set(nativeTargets.map((target) => target.targetId));
  let remaining = true;
  for (let step = 0; step < 120; step++) {
    remaining = (await cdp.send("Target.getTargets")).targetInfos.some((target) =>
      nativeIds.has(target.targetId),
    );
    if (!remaining) break;
    await delay(250);
  }
  assert.equal(remaining, false, "Cancelled native authorization target remained alive");
  assert.equal(mainPages(app.browser).length, 1);
  console.log(
    `PASS: ${platform}/${arch} unmodified packaged desktop enables WeCom scanning and cancels its native target`,
  );
} catch (error) {
  console.error(`[packaged-identity] ${platform}/${arch}: validation failed`, error);
  throw error;
} finally {
  stage("cleaning up the test-owned process tree");
  await app?.close();
  // Windows 的 Cookies 句柄可能在进程退出后短暂占用；使用 fs 的定向重试，耗尽后仍让验收失败。
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
