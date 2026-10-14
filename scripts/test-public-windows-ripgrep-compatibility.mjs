#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as pins,
  assertSha256,
} from "./public-windows-ripgrep-plan.mjs";
import { execute } from "./public-windows-ripgrep-source.mjs";

function option(name) {
  const p = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(p));
  if (inline) return inline.slice(p.length);
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
async function invoke(binary, args, cwd, input) {
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
function normalize(result, format) {
  if (format === "json")
    return {
      ...result,
      stdout: result.stdout
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => withoutElapsed(JSON.parse(line))),
    };
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

async function main() {
  const arch = option("arch") ?? process.arch;
  assert.equal(process.platform, "win32", "Compatibility must execute on Windows");
  assert.equal(process.arch, arch, "Compatibility must execute on the native target architecture");
  const candidate = resolve(option("candidate"));
  const archive = resolve(option("baseline-archive"));
  const output = resolve(option("output-dir"));
  await mkdir(output, { recursive: true });
  const expectedArchive =
    arch === "arm64"
      ? "88660d96f822d2e0329e254031068e82028f9c13efcec9b2d78c5a19d3f9ac47"
      : "ede1d7f533f30d7e2870f77139d0fb9d7591daad5260b80d6a525e0bb5bd440e";
  assertSha256(await readFile(archive), expectedArchive, "Original compatibility baseline archive");
  const work = await mkdtemp(join(tmpdir(), "uwork-rg-compat-"));
  const baselineDir = join(work, "baseline");
  await mkdir(baselineDir);
  await execute("tar", ["-xf", archive, "-C", baselineDir]);
  const baseline = join(baselineDir, "rg.exe");
  assertSha256(
    await readFile(baseline),
    arch === "arm64"
      ? "6545d832a57164e54405f019cf6861c397920aa1d6cc4569bfd85441f79ea043"
      : "57aec5102a212204920d089562d9dbcaa438e9f2222d9a370d439622441b64f0",
    "Original compatibility baseline executable",
  );
  const fixture = join(work, "fixture");
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
  const version = await invoke(candidate, ["--version"], fixture);
  assert.equal(version.code, 0);
  assert.equal(
    version.stdout.split(/\r?\n/u)[0],
    `ripgrep ${pins.version} (rev ${pins.sourceCommit.slice(0, 10)})`,
  );
  assert.match(version.stdout, /features:\+pcre2/u);
  assert.match(version.stdout, /PCRE2 10\.43 is available/u);
  const cases = [
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
  ];
  const results = [];
  for (const entry of cases) {
    const old = await invoke(baseline, entry.args, fixture, entry.input);
    const current = await invoke(candidate, entry.args, fixture, entry.input);
    assert.equal(old.code, entry.code, `${entry.name}: baseline status`);
    assert.equal(current.code, entry.code, `${entry.name}: candidate status`);
    assert.deepEqual(
      normalize(current, entry.format),
      normalize(old, entry.format),
      `${entry.name}: observable behavior changed`,
    );
    results.push({ name: entry.name, status: current.code, passed: true });
  }
  await writeFile(
    join(output, "compatibility.json"),
    JSON.stringify(
      { nativePlatform: process.platform, nativeArch: process.arch, cases: results },
      null,
      2,
    ) + "\n",
  );
  console.log(`PASS ${cases.length} real native compatibility cases (${arch})`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
