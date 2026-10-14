import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  invokeRipgrep,
  normalizeCompatibilityResult,
  prepareRipgrepCompatibilityFixture,
  RIPGREP_COMPATIBILITY_CASES,
} from "./public-ripgrep-compatibility.mjs";
import { execute, PCRE2_SOURCE_PINS } from "./public-windows-ripgrep-source.mjs";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as pins,
  assertSha256,
  sha256,
} from "./public-windows-ripgrep-plan.mjs";
import { LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET } from "./native-search-tools-config.mjs";
import { verifyMacosDeploymentTarget } from "./native-search-tools-verify.mjs";

export const REMOTE_RIPGREP_EXTRA_CASES = Object.freeze([
  {
    name: "remote hidden and explicit ignore bypass",
    args: ["--json", "--hidden", "--no-ignore", "--glob", "!.git/**", "needle", "."],
    code: 0,
    format: "json",
  },
  {
    name: "remote case-insensitive fixed string",
    args: ["--json", "--ignore-case", "--fixed-strings", "NEEDLE", "中文🙂.ts"],
    code: 0,
    format: "json",
  },
  {
    name: "remote bounded context",
    args: ["--json", "--context", "1", "--max-count", "1", "中文", "中文🙂.ts"],
    code: 0,
    format: "json",
  },
  {
    name: "remote files with matches",
    args: ["--files-with-matches", "--null", "--hidden", "--glob", "!.git/**", "needle", "."],
    code: 0,
    format: "paths",
  },
  {
    name: "remote adapter current flags",
    args: [
      "--no-config",
      "--hidden",
      "--color",
      "never",
      "--no-heading",
      "--with-filename",
      "--max-columns",
      "500",
      "--glob",
      "!.git",
      "--glob",
      "!**/.git/**",
      "--json",
      "--only-matching",
      "-e",
      "needle",
      "--",
      ".",
    ],
    code: 0,
    format: "json",
  },
]);

export function assertRemoteRipgrepVersion(output, arch) {
  assert.equal(
    output.split(/\r?\n/u)[0],
    `ripgrep ${pins.version} (rev ${pins.sourceCommit.slice(0, 10)})`,
  );
  assert.match(output, /features:\+pcre2/u);
  assert.ok(output.includes(`PCRE2 ${PCRE2_SOURCE_PINS.version} is available`));
  assert.match(output, arch === "x64" ? /JIT is available/u : /JIT is not available/u);
}

export function assertRemoteRipgrepResult(current, baseline, format) {
  assert.equal(current.code, baseline.code, "Remote exit status changed");
  if (format === "text" && baseline.code === 2) {
    // rg 大版本调整了错误排版；保留真实失败语义，不抹去匹配结果中的差异。
    for (const result of [current, baseline]) {
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /regex parse error:/u);
      assert.match(result.stderr, /unclosed character class/u);
    }
    return;
  }
  assert.deepEqual(
    normalizeCompatibilityResult(current, format),
    normalizeCompatibilityResult(baseline, format),
  );
}

export async function compareRemoteRipgrepBehavior({ candidate, baseline, fixtureDir }) {
  await prepareRipgrepCompatibilityFixture(fixtureDir);
  const results = [];
  for (const entry of [...RIPGREP_COMPATIBILITY_CASES, ...REMOTE_RIPGREP_EXTRA_CASES]) {
    const previous = await invokeRipgrep(baseline, entry.args, fixtureDir, entry.input);
    const current = await invokeRipgrep(candidate, entry.args, fixtureDir, entry.input);
    assert.equal(previous.code, entry.code, `${entry.name}: baseline exit`);
    assert.equal(current.code, entry.code, `${entry.name}: candidate exit`);
    try {
      assertRemoteRipgrepResult(current, previous, entry.format);
    } catch (error) {
      throw new Error(`${entry.name}: ${error.message}`, { cause: error });
    }
    results.push({
      name: entry.name,
      args: entry.args,
      baseline: previous,
      candidate: current,
      passed: true,
    });
  }
  return results;
}

export async function verifyRemoteRipgrepCandidate({
  candidate,
  baselineArchive,
  outputDir,
  arch,
}) {
  assert.equal(process.platform, "darwin", "Remote comparison requires macOS");
  assert.equal(process.arch, arch, "Remote comparison requires a native matching runner");
  const output = resolve(outputDir);
  await mkdir(output, { recursive: true });
  const bytes = await readFile(baselineArchive);
  assertSha256(
    bytes,
    LEGACY_REMOTE_RIPGREP_ARCHIVE_SHA256_BY_TARGET[`darwin-${arch}`],
    "Legacy remote archive",
  );
  const previousDir = join(output, "remote-rg13-baseline");
  await mkdir(previousDir);
  await execute("tar", ["-xzf", resolve(baselineArchive), "-C", previousDir]);
  const baseline = join(previousDir, "rg");
  const baselineVersion = await invokeRipgrep(baseline, ["--version"], output);
  const baselinePcre = await invokeRipgrep(baseline, ["--pcre2-version"], output);
  assert.equal(baselineVersion.code, 0);
  assert.match(baselineVersion.stdout, /^ripgrep 13\.0\.0 \(rev af6b6c543b\)/u);
  assert.equal(baselinePcre.code, 0);
  assert.match(baselinePcre.stdout, /PCRE2 10\.32 is available/u);
  assert.equal(baselinePcre.stdout.includes("JIT is available"), arch === "x64");
  const version = await invokeRipgrep(resolve(candidate), ["--version"], output);
  assert.equal(version.code, 0);
  assertRemoteRipgrepVersion(version.stdout, arch);
  const reports = {};
  for (const [label, binary] of [
    ["baseline", baseline],
    ["candidate", resolve(candidate)],
  ]) {
    const commands = await execute("otool", ["-l", binary], { capture: true });
    verifyMacosDeploymentTarget(commands, label);
    reports[label] = {
      loadCommands: commands,
      version: label === "baseline" ? baselineVersion : version,
    };
  }
  const results = await compareRemoteRipgrepBehavior({
    candidate: resolve(candidate),
    baseline,
    fixtureDir: join(output, "remote-compat-fixtures"),
  });
  const evidence = {
    schemaVersion: 1,
    status: "passed",
    platform: "darwin",
    arch,
    candidateSha256: sha256(await readFile(candidate)),
    baselineArchiveSha256: sha256(bytes),
    baselinePcre,
    reports,
    results,
    limitation: "普通 CLI 兼容验收；未执行漏洞 PoC，也未修改运行时分发计划。",
  };
  await writeFile(
    join(output, "remote-ripgrep-compatibility.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  return evidence;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const arg = (name) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  await verifyRemoteRipgrepCandidate({
    candidate: arg("candidate"),
    baselineArchive: arg("baseline-archive"),
    outputDir: arg("output-dir"),
    arch: arg("arch"),
  });
}
