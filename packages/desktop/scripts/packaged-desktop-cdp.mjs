import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { terminateProcessTreeAndWait } from "@zcode/services/process/processTreeTerminator";

const CDP_START_TIMEOUT_MS = 90_000;

/** 复用进程树 owner 的身份校验和回收边界，包括另建进程组的 Agent；不按名称扫描。 */
export async function stopOwnedDesktopProcess(child) {
  if (!child?.pid) return;
  const result = await terminateProcessTreeAndWait(child, {
    forceAfterMs: 1000,
    waitAfterForceMs: 5000,
  });
  if (result.remainingPids.length) throw new Error("Test-owned desktop process cleanup incomplete");
}

/** 生产包关闭 Node Inspector 仍可通过 Chromium CDP 验证真实窗口，不改写安装包。 */
export async function launchPackagedDesktopCdp({ executablePath, env, platform }) {
  const child = spawn(
    executablePath,
    ["--remote-debugging-port=0", ...(platform === "linux" ? ["--no-sandbox"] : [])],
    {
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.resume();
  let browser;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let buffer = "";
      const finish = (error, value) => {
        clearTimeout(timer);
        child.stderr.removeListener("data", inspect);
        child.removeListener("error", failed);
        child.removeListener("exit", exited);
        if (error) reject(error);
        else resolve(value);
      };
      const inspect = (bytes) => {
        buffer = (buffer + bytes.toString()).slice(-8192);
        const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) finish(undefined, match[1]);
      };
      const failed = (error) => finish(error);
      const exited = (code, signal) =>
        finish(new Error(`Packaged desktop exited before CDP: ${code ?? signal}`));
      const timer = setTimeout(
        () => finish(new Error("Packaged desktop did not expose Chromium CDP")),
        CDP_START_TIMEOUT_MS,
      );
      child.stderr.on("data", inspect);
      child.once("error", failed);
      child.once("exit", exited);
    });
    // 继续消费应用日志，避免 pipe 背压影响真实启动；不把配置或凭据转发到 CI。
    child.stderr.resume();
    browser = await chromium.connectOverCDP(endpoint, { timeout: 60_000 });
    return {
      browser,
      async close() {
        try {
          await browser.close();
        } finally {
          await stopOwnedDesktopProcess(child);
        }
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    await stopOwnedDesktopProcess(child);
    throw error;
  }
}
