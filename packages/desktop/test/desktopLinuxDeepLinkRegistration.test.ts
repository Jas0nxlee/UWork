import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLinuxDeepLinkProtocol } from "../src/main/desktopLinuxDeepLinkRegistration.js";

test("system desktop entry removes both owned marker generations and preserves user entries", async () => {
  const base = await mkdtemp(join(tmpdir(), "uwork-linux-desktop-"));
  const userApplications = join(base, "user", "applications");
  const systemApplications = join(base, "system", "applications");
  const userEntry = join(userApplications, "zcode.desktop");
  try {
    await mkdir(userApplications, { recursive: true });
    await mkdir(systemApplications, { recursive: true });
    await writeFile(join(systemApplications, "zcode.desktop"), "[Desktop Entry]\nName=UWork\n");
    for (const marker of ["ZCode", "UWork"]) {
      await writeFile(userEntry, `[Desktop Entry]\nComment=${marker} Desktop App\n`);
      registerLinuxDeepLinkProtocol({
        executablePath: "/fixture/UWork",
        homeDir: base,
        env: { XDG_DATA_HOME: join(base, "user") },
        systemApplicationDirs: [systemApplications],
        logger: { info() {}, warn() {} },
        runCommand: () => ({ status: 0, signal: null }),
      });
      await assert.rejects(readFile(userEntry), { code: "ENOENT" });
    }
    await writeFile(userEntry, "[Desktop Entry]\nComment=Personal launcher\n");
    registerLinuxDeepLinkProtocol({
      executablePath: "/fixture/UWork",
      homeDir: base,
      env: { XDG_DATA_HOME: join(base, "user") },
      systemApplicationDirs: [systemApplications],
      logger: { info() {}, warn() {} },
      runCommand: () => ({ status: 0, signal: null }),
    });
    assert.match(await readFile(userEntry, "utf8"), /Personal launcher/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
