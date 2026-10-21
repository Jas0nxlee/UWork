import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createVitest } from "vitest/node";
import { nodeUnitTestFiles } from "../node-unit-test-files.mjs";

const root = resolve(import.meta.dirname, "../..");

async function nodeTestSources() {
  const native = [];
  async function walk(directory, sourceContracts = false) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (relative(root, file).replaceAll("\\", "/") === "packages/desktop/test/e2e") continue;
        await walk(file, sourceContracts);
      } else if (
        entry.isFile() &&
        (sourceContracts ? entry.name === "contract.test.ts" : entry.name.endsWith(".test.ts"))
      ) {
        const source = ts.createSourceFile(
          file,
          await readFile(file, "utf8"),
          ts.ScriptTarget.Latest,
        );
        let importsNode = false;
        const visit = (node) => {
          if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === "node:test"
          )
            importsNode = true;
          if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === "node:test"
          )
            importsNode = true;
          ts.forEachChild(node, visit);
        };
        visit(source);
        if (importsNode) native.push(relative(root, file).replaceAll("\\", "/"));
      }
    }
  }
  for (const pkg of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    await walk(join(root, "packages", pkg.name, "test"));
    await walk(join(root, "packages", pkg.name, "src"), true);
  }
  return native.sort();
}

test("every package-level Node test is registered exactly once and excluded from real Vitest specs", async () => {
  assert.equal(new Set(nodeUnitTestFiles).size, nodeUnitTestFiles.length);
  assert.deepEqual([...nodeUnitTestFiles].sort(), await nodeTestSources());
  const vitest = await createVitest(
    "test",
    { root, watch: false, run: true },
    { server: { watch: null } },
  );
  try {
    const specs = await vitest.globTestSpecifications();
    const paths = new Set(specs.map((spec) => relative(root, spec.moduleId).replaceAll("\\", "/")));
    assert.deepEqual(
      nodeUnitTestFiles.filter((file) => paths.has(file)),
      [],
    );
  } finally {
    await vitest.close();
  }
});

for (const shouldFail of [false, true]) {
  test(`Node runner executes TypeScript assertions and preserves ${shouldFail ? "failure" : "success"}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "uwork-node-unit-"));
    try {
      await writeFile(join(cwd, "package.json"), '{"type":"module"}');
      await writeFile(join(cwd, "value.ts"), "export const value: number = 42;");
      await writeFile(
        join(cwd, "native.test.ts"),
        `import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { value } from "./value.js";
test("actual TypeScript assertion", async () => {
  await writeFile(new URL("./executed", import.meta.url), "yes");
  assert.equal(value, ${shouldFail ? 0 : 42});
});`,
      );
      const { runNodeUnitTests } = await import("../run-node-unit-tests.mjs");
      assert.equal(
        await runNodeUnitTests(["native.test.ts"], { cwd, stdio: "ignore" }),
        shouldFail ? 1 : 0,
      );
      assert.equal(await readFile(join(cwd, "executed"), "utf8"), "yes");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("pre-push and release CI run the same native suite entry", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.match(
    pkg.scripts["test:unit:node"],
    /node --test scripts\/test\/node-unit-runner\.test\.mjs/,
  );
  assert.match(pkg.scripts["test:unit:node"], /node scripts\/run-node-unit-tests\.mjs/);
  assert.match(pkg.scripts["verify:pre-push"], /pnpm run test:unit:node/);
  assert.match(
    await readFile(join(root, ".github/workflows/desktop-release.yml"), "utf8"),
    /run: pnpm test:unit:node/,
  );
});

test("empty native file lists cannot fall back to global Node test discovery", async () => {
  const { runNodeUnitTests } = await import("../run-node-unit-tests.mjs");
  await assert.rejects(runNodeUnitTests([], { stdio: "ignore" }), /清单不能为空/);
});
