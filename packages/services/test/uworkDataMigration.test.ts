import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyDataDirectory } from "../src/paths.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "uwork-migration-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("migration retains all UWork state and relocates metadata without copying bootstrap or upstream", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    const files = {
      "v2/credentials.json": '{"fixture":true}',
      "v2/setting.json": '{"dataBaseDir":"old"}',
      "cli/config.json":
        '{"mcp":{"servers":{"fixture":{"enabled":false,"command":"fixture"}}},"plugins":{"enabledPlugins":{"fixture@personal":false}}}',
      "skills/demo/SKILL.md": "fixture skill",
      "commands/demo.md": "fixture command",
      "workflows/demo.md": "fixture workflow",
      "plugins/demo/plugin.json": JSON.stringify({ path: join(old, ".uwork", "skills", "demo") }),
    };
    for (const [name, data] of Object.entries(files)) {
      const path = join(old, ".uwork", name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, data);
    }
    await mkdir(join(old, ".zcode"));
    await writeFile(join(old, ".zcode", "private"), "unchanged");
    await copyDataDirectory(old, next);
    for (const [name, data] of Object.entries(files)) {
      if (name === "v2/setting.json" || name === "plugins/demo/plugin.json") continue;
      assert.equal(await readFile(join(next, ".uwork", name), "utf8"), data);
    }
    assert.equal(
      JSON.parse(await readFile(join(next, ".uwork", "plugins/demo/plugin.json"), "utf8")).path,
      join(next, ".uwork", "skills", "demo"),
    );
    await assert.rejects(readFile(join(next, ".uwork", "v2/setting.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(next, ".zcode", "private")), { code: "ENOENT" });
    assert.equal(await readFile(join(old, ".zcode", "private"), "utf8"), "unchanged");
  }));

test("target conflicts and copy failures preserve old state without migration residue", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    await mkdir(join(old, ".uwork"), { recursive: true });
    await writeFile(join(old, ".uwork", "state"), "old");
    await mkdir(join(next, ".uwork"), { recursive: true });
    await writeFile(join(next, ".uwork", "state"), "target");
    await assert.rejects(copyDataDirectory(old, next), /not empty/);
    assert.equal(await readFile(join(next, ".uwork", "state"), "utf8"), "target");
    await rm(join(next, ".uwork"), { recursive: true });
    await assert.rejects(copyDataDirectory(join(root, "missing"), next), { code: "ENOENT" });
    assert.deepEqual(await readdir(next), []);
    assert.equal(await readFile(join(old, ".uwork", "state"), "utf8"), "old");
  }));
