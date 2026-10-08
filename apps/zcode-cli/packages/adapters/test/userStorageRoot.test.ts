import assert from "node:assert/strict";
import test from "node:test";
import { resolveUserCliConfigPath, resolveUserCliRoot, resolveUserStorageRoot } from "@zcode/shared";
import { getDefaultConfigPath } from "../src/config/file-config.adapter.js";
import { getDefaultLogDir } from "../src/logging/index.js";
import { resolveDefaultSkillRoots } from "../src/skills/roots.js";
import { getDefaultSessionDbPath } from "../src/storage/session-store/paths.js";

// 用户级目录必须跟随 Host 下发的 storage root（UWork 下为 {dataBaseDir}/.uwork），
// 未下发时才回落上游 ~/.zcode。回归背景见 specs/uwork-data-root-separation.md。

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  operation: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("下发 ZCODE_STORAGE_DIR 时，用户级目录全部落在产品数据根下", async () => {
  await withEnv({ ZCODE_STORAGE_DIR: "/tmp/uwork-root" }, () => {
    assert.equal(resolveUserStorageRoot(), "/tmp/uwork-root");
    assert.equal(resolveUserCliRoot(), "/tmp/uwork-root/cli");
    assert.equal(resolveUserCliConfigPath(), "/tmp/uwork-root/cli/config.json");
    assert.equal(getDefaultConfigPath(), "/tmp/uwork-root/cli/config.json");
    assert.equal(getDefaultSessionDbPath(), "/tmp/uwork-root/cli/db/db.sqlite");
    assert.equal(getDefaultLogDir(), "/tmp/uwork-root/cli/log");
  });
});

test("storage root 已指向 cli 目录时不再重复拼接", async () => {
  await withEnv({ ZCODE_STORAGE_DIR: "/tmp/uwork-root/cli/" }, () => {
    assert.equal(resolveUserCliRoot(), "/tmp/uwork-root/cli");
    assert.equal(resolveUserCliConfigPath(), "/tmp/uwork-root/cli/config.json");
  });
});

test("未下发 storage root 时保持上游默认 ~/.zcode", async () => {
  await withEnv({ HOME: "/tmp/home", ZCODE_STORAGE_DIR: undefined }, () => {
    assert.equal(resolveUserStorageRoot(), "/tmp/home/.zcode");
    assert.equal(getDefaultConfigPath(), "/tmp/home/.zcode/cli/config.json");
  });
});

test("用户级技能根跟随产品数据根，.agents 与项目级保持原约定", async () => {
  await withEnv({ ZCODE_STORAGE_DIR: "/tmp/uwork-root", HOME: "/tmp/home" }, async () => {
    const roots = await resolveDefaultSkillRoots("/tmp/workspace", {
      homeDirectory: "/tmp/home",
    });
    const byPriority = roots.toSorted((left, right) => left.priority - right.priority);
    const userRoots = byPriority.filter((root) => root.scope === "user");
    assert.deepEqual(
      userRoots.map((root) => root.path),
      ["/tmp/uwork-root/skills", "/tmp/home/.agents/skills"],
    );
    const projectRoots = byPriority.filter((root) => root.scope === "project");
    assert.ok(
      projectRoots.every((root) => root.path.startsWith("/tmp/")),
      `项目级根不应被重定向：${projectRoots.map((root) => root.path).join(", ")}`,
    );
  });
});
