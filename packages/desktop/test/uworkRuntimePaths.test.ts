import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getAppConfigDir,
  getUworkUserCliConfigPath,
  getUworkUserStorageRoot,
  setDataBaseDir,
} from "../../services/src/paths.js";
import { resolveUserCliConfigPath } from "@zcode/shared";
import { applyEarlyDataBaseDirBootstrap } from "../src/main/desktopDataBaseDirBootstrap.js";
import {
  loadCliMcpFromUserDirectory,
  saveCliMcpToUserDirectory,
} from "../src/main/mcpUserDirectory/index.js";

test("saved dataBaseDir bootstrap and storage override keep desktop MCP and Agent on the same file", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-runtime-path-test-"));
  const keys = [
    "HOME",
    "ZCODE_DESKTOP_HOME_DIR",
    "UWORK_DATA_BASE_DIR",
    "ZCODE_DATA_BASE_DIR",
    "ZCODE_STORAGE_DIR",
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.HOME = root;
    process.env.ZCODE_DESKTOP_HOME_DIR = root;
    delete process.env.UWORK_DATA_BASE_DIR;
    delete process.env.ZCODE_DATA_BASE_DIR;
    const data = join(root, "custom");
    await mkdir(join(root, ".uwork", "v2"), { recursive: true });
    await writeFile(
      join(root, ".uwork", "v2", "setting.json"),
      JSON.stringify({ dataBaseDir: data }),
    );
    assert.equal(applyEarlyDataBaseDirBootstrap(), data);
    for (const storage of [undefined, join(root, "external"), join(root, "external", "cli")]) {
      if (storage) process.env.ZCODE_STORAGE_DIR = storage;
      else delete process.env.ZCODE_STORAGE_DIR;
      const agent = resolveUserCliConfigPath({ ZCODE_STORAGE_DIR: getUworkUserStorageRoot() });
      assert.equal(getUworkUserCliConfigPath(), agent);
      assert.equal(getAppConfigDir(), join(data, ".uwork", "v2"));
      await saveCliMcpToUserDirectory({
        action: "upsert",
        name: "fixture",
        config: { command: "fixture", enabled: false },
      });
      assert.equal(JSON.parse(await readFile(agent, "utf8")).mcp.servers.fixture.enabled, false);
      assert.ok(
        (await loadCliMcpFromUserDirectory()).servers.some((server) => server.name === "fixture"),
      );
      await saveCliMcpToUserDirectory({ action: "set-enabled", name: "fixture", enabled: true });
      assert.notEqual(JSON.parse(await readFile(agent, "utf8")).mcp.servers.fixture.enabled, false);
      setDataBaseDir(null);
      assert.equal(applyEarlyDataBaseDirBootstrap(), data);
      assert.ok(
        (await loadCliMcpFromUserDirectory()).servers.some((server) => server.name === "fixture"),
      );
      await saveCliMcpToUserDirectory({ action: "remove", name: "fixture" });
      assert.equal(JSON.parse(await readFile(agent, "utf8")).mcp.servers.fixture, undefined);
    }
    await assert.rejects(readFile(join(root, ".uwork", "cli", "config.json")), { code: "ENOENT" });
  } finally {
    setDataBaseDir(null);
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});
