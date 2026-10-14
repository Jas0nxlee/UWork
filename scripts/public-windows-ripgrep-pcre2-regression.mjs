import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execute, PCRE2_SOURCE_PINS } from "./public-windows-ripgrep-source.mjs";
import { sha256 } from "./public-windows-ripgrep-plan.mjs";

export const PCRE2_REQUIRED_WINDOWS_TESTS = Object.freeze([
  "pcre2_test_bat",
  "pcre2_grep_test_bat",
  "pcre2_jit_test",
  "pcre2posix_test",
]);

export function assertPcre2StandardTests(listed, junit) {
  assert.ok(listed.length >= PCRE2_REQUIRED_WINDOWS_TESTS.length, "Missing official PCRE2 tests");
  for (const name of PCRE2_REQUIRED_WINDOWS_TESTS)
    assert.ok(listed.includes(name), `Missing official PCRE2 test ${name}`);
  assert.doesNotMatch(junit, /<(?:failure|error|skipped)\b/u, "PCRE2 test failure or skip");
  for (const attribute of ["failures", "errors", "skipped", "disabled"])
    for (const match of junit.matchAll(new RegExp(`\\b${attribute}="([^"]+)"`, "gu")))
      assert.equal(Number(match[1]), 0, `PCRE2 ${attribute} must be zero`);
  const completed = [...junit.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  assert.equal(new Set(completed).size, completed.length, "Duplicate PCRE2 test result");
  assert.deepEqual([...completed].sort(), [...listed].sort(), "Incomplete PCRE2 CTest execution");
  return completed;
}

export async function runPcre2StandardRegression({
  source,
  workDir,
  artifactsDir,
  env,
  plan,
  candidateSha256,
}) {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, plan.arch);
  assert.equal(source.pcre2.version, PCRE2_SOURCE_PINS.version);
  assert.equal(source.pcre2.archiveSha256, PCRE2_SOURCE_PINS.archiveSha256);
  const buildDir = join(workDir, "pcre2-standard-tests");
  const configureArgs = [
    "-S",
    source.pcre2.releaseDir,
    "-B",
    buildDir,
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
    `-DCMAKE_C_FLAGS=${plan.cflags}`,
    "-DPCRE2_BUILD_PCRE2_8=ON",
    "-DPCRE2_BUILD_PCRE2_16=ON",
    "-DPCRE2_BUILD_PCRE2_32=ON",
    "-DPCRE2_SUPPORT_JIT=ON",
    "-DPCRE2_BUILD_TESTS=ON",
    "-DPCRE2_BUILD_PCRE2GREP=ON",
    "-DBUILD_SHARED_LIBS=OFF",
    "-DBUILD_STATIC_LIBS=ON",
  ];
  await execute("cmake", configureArgs, {
    env,
    logPath: join(artifactsDir, "pcre2-cmake-configure.log"),
  });
  await execute("cmake", ["--build", buildDir, "--parallel", "4"], {
    env,
    logPath: join(artifactsDir, "pcre2-cmake-build.log"),
  });
  const listed = JSON.parse(
    await execute("ctest", ["--test-dir", buildDir, "--show-only=json-v1"], { env, capture: true }),
  );
  await writeFile(
    join(artifactsDir, "pcre2-ctest-inventory.json"),
    JSON.stringify(listed, null, 2) + "\n",
  );
  const names = listed.tests?.map((entry) => entry.name) ?? [];
  for (const name of PCRE2_REQUIRED_WINDOWS_TESTS)
    assert.ok(names.includes(name), `Missing official PCRE2 test ${name}`);
  const junitFile = "pcre2-ctest.xml";
  const logFile = "pcre2-ctest.log";
  await execute(
    "ctest",
    [
      "--test-dir",
      buildDir,
      "--output-on-failure",
      "--output-junit",
      join(artifactsDir, junitFile),
    ],
    { env, logPath: join(artifactsDir, logFile) },
  );
  const junit = await readFile(join(artifactsDir, junitFile));
  const tests = assertPcre2StandardTests(names, junit.toString("utf8"));
  const evidence = {
    status: "passed",
    version: PCRE2_SOURCE_PINS.version,
    nativePlatform: process.platform,
    nativeArch: process.arch,
    sourceEvidenceSha256: sha256(await readFile(join(artifactsDir, "pcre2-source-evidence.json"))),
    archiveSha256: source.pcre2.archiveSha256,
    candidateSha256,
    configureArgs,
    tests,
    junit: { file: junitFile, sha256: sha256(junit) },
    log: { file: logFile, sha256: sha256(await readFile(join(artifactsDir, logFile))) },
    limitation:
      "Only the updated official release standard suite ran; independent failing-before/passing-after PoC was not run.",
  };
  await writeFile(
    join(artifactsDir, "pcre2-standard-regression.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  return evidence;
}
