import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { stopOwnedDesktopProcess } from "../scripts/packaged-desktop-cdp.mjs";

it("terminates only the test-owned process and keeps a separate process alive", async () => {
  const start = () =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
  const owned = start();
  const other = start();
  try {
    await stopOwnedDesktopProcess(owned);
    expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    expect(other.exitCode).toBeNull();
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
  } finally {
    await stopOwnedDesktopProcess(owned);
    await stopOwnedDesktopProcess(other);
  }
});
