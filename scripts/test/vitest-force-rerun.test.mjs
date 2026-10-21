import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { createVitest } from "vitest/node";
import { configDefaults } from "vitest/config";
import { createForceRerunTriggers } from "../vitest-force-rerun.mjs";

async function fixture(run, name = "work[1]{two}(3)!+@") {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "uwork-force-trigger-")));
  const root = join(parent, ".hidden", name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await symlink(
    resolve("node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(join(root, "source.mjs"), "export const value = 1;");
  await writeFile(
    join(root, "a.test.mjs"),
    'import { test } from "vitest"; import {value} from "./source.mjs"; test("a",()=>value);',
  );
  await writeFile(join(root, "b.test.mjs"), 'import { test } from "vitest"; test("b",()=>{});');
  const vitest = await createVitest(
    "test",
    {
      root,
      config: false,
      watch: false,
      run: true,
      include: ["*.test.mjs"],
      forceRerunTriggers: createForceRerunTriggers(root, configDefaults.forceRerunTriggers),
    },
    { server: { watch: null } },
  );
  try {
    const all = await vitest.globTestSpecifications();
    assert.equal(all.length, 2);
    const relevant = async (path) => {
      vitest.config.changed = false;
      vitest.config.related = [path];
      return (await vitest.getRelevantTestSpecifications())
        .map((spec) => basename(spec.moduleId))
        .sort();
    };
    await run({ root, vitest, relevant });
  } finally {
    await vitest.close();
    await rm(parent, { recursive: true, force: true });
  }
}

test("hidden roots and literal glob characters preserve configuration triggers and business selection", async () => {
  await fixture(async ({ root, vitest, relevant }) => {
    for (const file of [
      "vitest.config.ts",
      "vitest.setup.ts",
      "packages/demo/vite.config.mts",
      "package.json",
    ]) {
      assert.deepEqual(await relevant(join(root, file)), ["a.test.mjs", "b.test.mjs"], file);
    }
    assert.deepEqual(await relevant(join(root, "source.mjs")), ["a.test.mjs"]);
    const lookalike = join(dirname(root), "work1two3!+@", "vitest.config.ts");
    assert.deepEqual(await relevant(lookalike), []);
    for (const pattern of configDefaults.forceRerunTriggers)
      assert.ok(vitest.config.forceRerunTriggers.includes(pattern));
  });
});

test("Windows root separators and glob characters use the same official matcher without broadening roots", async () => {
  await fixture(async ({ vitest, relevant }) => {
    const windowsRoot = "C:\\Users\\fixture\\.codex\\work[1]{two}(3)!+@";
    vitest.config.forceRerunTriggers = createForceRerunTriggers(
      windowsRoot,
      configDefaults.forceRerunTriggers,
    );
    const normalized = windowsRoot.replaceAll("\\", "/");
    assert.deepEqual(await relevant(`${normalized}/vitest.config.ts`), [
      "a.test.mjs",
      "b.test.mjs",
    ]);
    assert.deepEqual(await relevant(`${normalized}/vitest.setup.ts`), ["a.test.mjs", "b.test.mjs"]);
    assert.deepEqual(
      await relevant(`${normalized.replace("work[1]{two}(3)", "work1two3")}/vitest.config.ts`),
      [],
    );
  });
});

test("ordinary business sources in hidden worktrees keep the official partial selection", async () => {
  await fixture(async ({ root, relevant }) => {
    assert.deepEqual(await relevant(join(root, "source.mjs")), ["a.test.mjs"]);
  }, "checkout");
});
