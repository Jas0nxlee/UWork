import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyDataDirectory, setDataBaseDir } from "../src/paths.js";

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

test("migration preserves disabled user skill and command path keys without rewriting arbitrary keys", async () =>
  fixture(async (root) => {
    const old = join(root, "old"),
      next = join(root, "new");
    const skill = join(old, ".uwork", "skills", "demo", "SKILL.md");
    const command = join(old, ".uwork", "commands", "demo.md");
    const unrelated = join(root, "workspace", "SKILL.md");
    await mkdir(join(old, ".uwork", "cli"), { recursive: true });
    await mkdir(join(skill, ".."), { recursive: true });
    await writeFile(skill, "---\nname: demo\ndescription: fixture\n---\nfixture");
    await mkdir(join(command, ".."), { recursive: true });
    await writeFile(command, "fixture command");
    await writeFile(
      join(old, ".uwork", "cli", "config.json"),
      JSON.stringify({
        skills: {
          [skill.replaceAll("\\", "/")]: { enable: false },
          [unrelated]: { enable: false },
        },
        command: { [command]: { enable: false } },
        custom: { [skill]: "ordinary key" },
      }),
    );
    await copyDataDirectory(old, next);
    const migrated = JSON.parse(await readFile(join(next, ".uwork", "cli", "config.json"), "utf8"));
    const canonicalSkill = await realpath(join(next, ".uwork", "skills", "demo", "SKILL.md"));
    assert.equal(migrated.skills[canonicalSkill.replaceAll("\\", "/")].enable, false);
    assert.equal(migrated.command[join(next, ".uwork", "commands", "demo.md")].enable, false);
    assert.equal(migrated.skills[unrelated].enable, false);
    assert.equal(migrated.custom[skill], "ordinary key");
    assert.equal(migrated.skills[skill], undefined);
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    setDataBaseDir(next);
    try {
      const { createSkillsService } = await import("../src/skills/skillsService.js");
      const workspacePath = join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const listing = await createSkillsService({ isDesktopRuntime: true }).list({ workspacePath });
      const restored = listing.skills.find((item) => item.path === canonicalSkill);
      assert.ok(restored, "relocated user skill must be visible after reader restart");
      assert.equal(restored.enabled, false, "disabled state must remain disabled");
    } finally {
      setDataBaseDir(null);
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  }));

test("Windows normalized skill keys and native command keys retain disabled overrides", async () => {
  const { relocateCliPathOverrides } = await import("../src/dataDirectoryMigrationMetadata.js");
  const config = {
    skills: { "C:/old/.uwork/skills/demo/SKILL.md": { enable: false } },
    command: { "C:\\old\\.uwork\\commands\\demo.md": { enable: false } },
    custom: { "C:/old/.uwork/skills/demo/SKILL.md": "ordinary" },
  };
  relocateCliPathOverrides(config, {
    source: "C:\\old\\.uwork",
    target: "D:\\new\\.uwork",
    canonicalSource: "C:\\old\\.uwork",
    canonicalTarget: "D:\\new\\.uwork",
  });
  assert.deepEqual(config.skills, { "D:/new/.uwork/skills/demo/SKILL.md": { enable: false } });
  assert.deepEqual(config.command, { "D:\\new\\.uwork\\commands\\demo.md": { enable: false } });
  assert.equal(config.custom["C:/old/.uwork/skills/demo/SKILL.md"], "ordinary");
});
