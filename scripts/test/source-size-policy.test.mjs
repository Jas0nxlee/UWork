import ts from "typescript";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

test("400 行为新文件阻断阈值，精确存量路径保留 800 行边界", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-size-policy-"));
  try {
    const { config } = ts.parseConfigFileTextToJson(
      ".oxlintrc.json",
      await readFile(join(root, ".oxlintrc.json"), "utf8"),
    );
    // 只验证规则本身；根 runner 排除 CLI，由独立 CLI runner 检查。
    config.ignorePatterns = [];
    await writeFile(join(cwd, ".oxlintrc.json"), JSON.stringify(config));
    const regular = "packages/example/src/new.ts";
    const retained = "packages/desktop/src/main/web-remote-relay/hmacTransport.ts";
    const neighbor = "packages/desktop/src/main/web-remote-relay/new-helper.ts";
    const accepted = "apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts";
    async function lint(file, lines) {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(
        join(cwd, file),
        Array.from({ length: lines }, (_, i) => `export const value${i} = ${i};`).join("\n"),
      );
      const packageRoot = file.startsWith("apps/zcode-cli/")
        ? "apps/zcode-cli/packages/bootstrap"
        : ".";
      const target = packageRoot === "." ? file : file.slice(packageRoot.length + 1);
      const result = await exec(
        process.execPath,
        [join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", target],
        { cwd: join(cwd, packageRoot) },
      ).catch((error) => error);
      return JSON.parse(result.stdout).diagnostics;
    }
    assert.equal(
      (await lint(regular, 400)).filter((x) => x.code === "eslint(max-lines)").length,
      0,
    );
    assert.equal(
      (await lint(regular, 401)).find((x) => x.code === "eslint(max-lines)")?.severity,
      "error",
    );
    // 同目录的新文件不继承 HMAC 存量文件的精确 800 行例外。
    assert.equal(
      (await lint(neighbor, 401)).find((x) => x.code === "eslint(max-lines)")?.severity,
      "error",
    );
    assert.equal(
      (await lint(retained, 800)).filter((x) => x.code === "eslint(max-lines)").length,
      0,
    );
    assert.equal(
      (await lint(retained, 801)).find((x) => x.code === "eslint(max-lines)")?.severity,
      "error",
    );
    assert.equal(
      (await lint(accepted, 801)).find((x) => x.code === "eslint(max-lines)")?.severity,
      "warning",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
