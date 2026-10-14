import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PUBLIC_WINDOWS_RIPGREP_PINS as pins } from "./public-windows-ripgrep-plan.mjs";
import { execute, PCRE2_SOURCE_PINS } from "./public-windows-ripgrep-source.mjs";

function withoutElapsed(value) {
  if (Array.isArray(value)) return value.map(withoutElapsed);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["elapsed", "elapsed_total"].includes(key))
        .map(([key, child]) => [key, withoutElapsed(child)]),
    );
  return value;
}

export function normalizeCompatibilityResult(result, format) {
  if (format === "json") {
    const blocks = new Map();
    let summary;
    for (const line of result.stdout.trim().split(/\r?\n/u).filter(Boolean)) {
      const event = withoutElapsed(JSON.parse(line));
      assert.equal(summary, undefined, "JSON events must precede the final summary");
      if (event.type === "summary") {
        summary = event;
        continue;
      }
      assert.ok(event.data?.path, "JSON file event requires a path");
      const key = JSON.stringify(event.data.path);
      if (event.type === "begin") {
        assert.ok(!blocks.has(key), "Duplicate JSON file begin");
        blocks.set(key, []);
      } else {
        assert.ok(["match", "context", "end"].includes(event.type), "Unexpected JSON event");
        assert.ok(blocks.has(key), "JSON file event precedes begin");
        assert.notEqual(blocks.get(key).at(-1)?.type, "end", "JSON file event follows end");
      }
      blocks.get(key).push(event);
    }
    assert.ok(summary, "Missing final JSON summary");
    for (const events of blocks.values())
      assert.equal(events.at(-1)?.type, "end", "Missing JSON file end");
    // rg 并行遍历不承诺跨文件顺序；只排序整块，保留每文件所有事件、偏移和统计。
    const files = [...blocks]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, events]) => events);
    return { ...result, stdout: { files, summary } };
  }
  if (format === "paths")
    return {
      ...result,
      stdout: result.stdout
        .split("\0")
        .flatMap((part) => part.split(/\r?\n/u))
        .filter(Boolean)
        .sort(),
    };
  return result;
}

export async function invokeRipgrep(binary, args, cwd, input) {
  const child = spawn(binary, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  child.stdin.end(input);
  const code = await new Promise((yes, no) => {
    child.once("error", no);
    child.once("close", yes);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

export const RIPGREP_COMPATIBILITY_CASES = Object.freeze([
  {
    name: "UTF-8 JSON and byte/line/column offsets",
    args: ["--json", "--line-number", "--column", "中文", "."],
    code: 0,
    format: "json",
  },
  {
    name: "PCRE2 lookbehind",
    args: ["--pcre2", "--json", "(?<=中文) result", "."],
    code: 0,
    format: "json",
  },
  {
    name: "multiline JSON",
    args: ["--multiline", "--json", "needle\\n中文", "."],
    code: 0,
    format: "json",
  },
  {
    name: "CRLF line boundaries",
    args: ["--crlf", "--json", "needle$", "crlf.txt"],
    code: 0,
    format: "json",
  },
  { name: "glob and Git ignore", args: ["--files", "--glob", "*.txt"], code: 0, format: "paths" },
  {
    name: "hidden files and explicit exclusion",
    args: ["--files", "--hidden", "--glob", "!.git/**", "--glob", "!ignored.txt"],
    code: 0,
    format: "paths",
  },
  {
    name: "NUL file names",
    args: ["--files", "--null", "--glob", "*.ts"],
    code: 0,
    format: "paths",
  },
  {
    name: "bounded matches",
    args: ["--json", "--max-count", "1", "needle", "中文🙂.ts"],
    code: 0,
    format: "json",
  },
  {
    name: "stdin UTF-8",
    args: ["--json", "needle"],
    input: "needle 中文\nother\n",
    code: 0,
    format: "json",
  },
  {
    name: "no match exit 1",
    args: ["--json", "definitely-absent", "."],
    code: 1,
    format: "json",
  },
  { name: "invalid regex exit 2", args: ["[", "."], code: 2, format: "text" },
]);

export async function prepareRipgrepCompatibilityFixture(fixture) {
  await mkdir(join(fixture, "子目录"), { recursive: true });
  await execute("git", ["init", "--quiet", fixture]);
  for (const [name, text] of Object.entries({
    ".gitignore": "ignored.txt\n",
    "ignored.txt": "needle ignored",
    ".hidden.txt": "needle hidden",
    "中文🙂.ts": "needle\n中文 result\nneedle again\n",
    "子目录/other.txt": "plain needle\n",
    "crlf.txt": "needle\r\n中文 result\r\n",
  }))
    await writeFile(join(fixture, name), text);
}

export async function runRipgrepCompatibility({
  candidate,
  baseline,
  fixtureDir: fixture,
  requireJit = true,
}) {
  await prepareRipgrepCompatibilityFixture(fixture);
  const version = await invokeRipgrep(candidate, ["--version"], fixture);
  assert.equal(version.code, 0);
  assert.equal(
    version.stdout.split(/\r?\n/u)[0],
    `ripgrep ${pins.version} (rev ${pins.sourceCommit.slice(0, 10)})`,
  );
  assert.match(version.stdout, /features:\+pcre2/u);
  assert.ok(version.stdout.includes(`PCRE2 ${PCRE2_SOURCE_PINS.version} is available`));
  assert.match(version.stdout, requireJit ? /JIT is available/u : /JIT is not available/u);
  const results = [];
  for (const entry of RIPGREP_COMPATIBILITY_CASES) {
    const old = await invokeRipgrep(baseline, entry.args, fixture, entry.input);
    const current = await invokeRipgrep(candidate, entry.args, fixture, entry.input);
    assert.equal(old.code, entry.code, `${entry.name}: baseline status`);
    assert.equal(current.code, entry.code, `${entry.name}: candidate status`);
    assert.deepEqual(
      normalizeCompatibilityResult(current, entry.format),
      normalizeCompatibilityResult(old, entry.format),
      `${entry.name}: observable behavior changed`,
    );
    results.push({ name: entry.name, status: current.code, passed: true });
  }
  return results;
}
