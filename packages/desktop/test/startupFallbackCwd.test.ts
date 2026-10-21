import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveStartupWindowBootstrap } from "../src/main/startupWorkspace.js";
import { ensureHostFallbackCwd } from "../src/host/database-startup/storagePreparationProcesses.js";
import { resolveZCodeAgentSpawnCwd } from "@zcode/services/storage-startup";

test("valid active workspace and deleted recent workspace use an existing managed fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-cwd-"));
  try {
    const active = join(root, "active");
    const deleted = join(root, "已删除项目");
    const fallback = join(root, "managed", "conversation");
    const settings = join(root, "setting.json");
    await mkdir(active);
    await writeFile(
      settings,
      JSON.stringify({
        lastWorkspaceSession: [{ kind: "local", workspacePath: active }],
        lastActiveTabIndex: 0,
        recentProjects: [deleted],
      }),
    );
    const bootstrap = await resolveStartupWindowBootstrap({
      settingsFile: settings,
      conversationWorkspaceDir: fallback,
    });
    assert.equal(bootstrap.agentWarmupTargets?.[0]?.workspacePath, active);
    // 当前 Main 只声明活动目标，失效 recent 不再拥有预热/创建入口；备用 cwd 由 Host 创建。
    assert.deepEqual(bootstrap.agentWarmupTargets, [{ workspacePath: active }]);
    await assert.rejects(stat(fallback), { code: "ENOENT" });
    await ensureHostFallbackCwd(fallback);
    const selection = await resolveZCodeAgentSpawnCwd({
      requestedCwd: deleted,
      workspacePath: deleted,
      spawnFallbackCwd: fallback,
    });
    assert.equal(selection.cwd, fallback);
    assert.equal(selection.cwdExists, true);
    await assert.rejects(stat(deleted), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh Host and repeated window startup create only the canonical backing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-cwd-fresh-"));
  try {
    const fallback = join(root, "managed", "conversation");
    await Promise.all([ensureHostFallbackCwd(fallback), ensureHostFallbackCwd(fallback)]);
    assert.equal((await stat(fallback)).isDirectory(), true);
    const selection = await resolveZCodeAgentSpawnCwd({
      requestedCwd: fallback,
      workspacePath: fallback,
      spawnFallbackCwd: fallback,
    });
    assert.equal(selection.cwdExists, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Host rejects a fallback path occupied by a file without replacing its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-cwd-blocked-"));
  try {
    const fallback = join(root, "existing-file");
    await writeFile(fallback, "preserve-existing-file");
    await assert.rejects(ensureHostFallbackCwd(fallback), { code: "EEXIST" });
    assert.equal((await stat(fallback)).isFile(), true);
    assert.equal(await readFile(fallback, "utf8"), "preserve-existing-file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
