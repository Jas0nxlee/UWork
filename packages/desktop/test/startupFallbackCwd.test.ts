import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveStartupWindowBootstrap } from "../src/main/startupWorkspace.js";
import { ensureHostFallbackCwd } from "../src/host/storagePreparationProcesses.js";
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
    assert.ok(bootstrap.agentWarmupTargets?.some((target) => target.workspacePath === deleted));
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
