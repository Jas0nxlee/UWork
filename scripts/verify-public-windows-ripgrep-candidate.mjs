#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as pins,
  sha256,
  readRustManifestComponents,
  createPublicWindowsRipgrepPlan,
} from "./public-windows-ripgrep-plan.mjs";
import { verifyPublicWindowsPeHardening } from "./public-windows-ripgrep-hardening.mjs";
import { createDeterministicRipgrepZip } from "./public-windows-ripgrep-archive.mjs";
import { assertBinskimSarif } from "./run-public-windows-ripgrep-binskim.mjs";
import { PCRE2_SOURCE_PINS } from "./public-windows-ripgrep-source.mjs";
import { RIPGREP_COMPATIBILITY_CASES } from "./public-ripgrep-compatibility.mjs";
import {
  PCRE2_REQUIRED_WINDOWS_TESTS,
  assertPcre2StandardTests,
} from "./public-windows-ripgrep-pcre2-regression.mjs";
import {
  assertPePdbBinding,
  readBuildProvenance,
} from "./public-windows-ripgrep-build-evidence.mjs";

export function materialFileRecords(value) {
  if (Array.isArray(value)) return value.flatMap(materialFileRecords);
  if (!value || typeof value !== "object") return [];
  if (typeof value.file === "string" && typeof value.sha256 === "string") return [value];
  return Object.values(value).flatMap(materialFileRecords);
}
export function assertCandidateReports(build, compatibility, materials, sarif) {
  assert.equal(build.status, "built-awaiting-compatibility-and-binskim");
  // 只接受固定官方新版及其正常上游回归；保留独立 PoC 未运行的真实限制，旧基线仍被阻断。
  const advisory = build.security?.pcre2?.advisories?.find(
    (entry) => entry.id === "GHSA-r9hj-j2rw-4q3m",
  );
  const securityCheck = (actual, expected) =>
    assert.deepEqual(
      actual,
      expected,
      "GHSA-r9hj-j2rw-4q3m requires complete official updated-source regression evidence",
    );
  securityCheck(advisory?.status, "patched");
  securityCheck(advisory?.regressionStatus, "not-run");
  securityCheck(
    advisory?.acceptance,
    "official-updated-release-standard-regression-and-native-cli",
  );
  securityCheck(build.security.pcre2.version, PCRE2_SOURCE_PINS.version);
  securityCheck(build.source.pcre2?.version, PCRE2_SOURCE_PINS.version);
  securityCheck(build.source.pcre2?.archiveSha256, PCRE2_SOURCE_PINS.archiveSha256);
  const standard = build.security.pcre2.standardRegression;
  securityCheck(standard?.status, "passed");
  securityCheck(standard?.version, PCRE2_SOURCE_PINS.version);
  securityCheck(standard?.archiveSha256, PCRE2_SOURCE_PINS.archiveSha256);
  securityCheck(standard?.sourceEvidenceSha256, build.source.pcre2.sha256);
  securityCheck(standard?.candidateSha256, build.outputs.executableSha256);
  securityCheck(standard?.nativePlatform, "win32");
  securityCheck(standard?.nativeArch, build.arch);
  for (const name of PCRE2_REQUIRED_WINDOWS_TESTS)
    securityCheck(standard?.tests?.includes(name), true);
  const upstream = build.security.pcre2.upstreamTests;
  securityCheck(upstream?.status, "passed");
  securityCheck(upstream?.sourceEvidenceSha256, build.source.pcre2.sha256);
  securityCheck(upstream?.candidateSha256, build.outputs.executableSha256);
  assert.equal(build.source.revision, pins.sourceCommit);
  assert.equal(
    build.target,
    createPublicWindowsRipgrepPlan({
      arch: build.arch,
      hostPlatform: "win32",
      hostArch: build.arch,
      env: {},
    }).target,
  );
  assert.equal(build.toolchain.commit, pins.rustCommit);
  assert.equal(build.toolchain.manifestSha256, pins.rustManifestSha256);
  assert.equal(build.hardening.stdRebuildRequired, true);
  assert.equal(build.hardening.panicStrategy, "unwind");
  assert.equal(build.hardening.rustcBootstrap, false);
  assert.equal(build.hardening.stdArtifact.fresh, false);
  assert.equal(build.hardening.panicArtifact.target.name, "panic_unwind");
  assert.equal(build.hardening.panicArtifact.fresh, false);
  assert.deepEqual(
    build.hardening.rustFlags,
    createPublicWindowsRipgrepPlan({
      arch: build.arch,
      hostPlatform: "win32",
      hostArch: build.arch,
      env: {},
    }).rustFlags,
  );
  assert.equal(compatibility.nativePlatform, "win32");
  assert.equal(compatibility.nativeArch, build.arch);
  assert.equal(compatibility.candidateSha256, build.outputs.executableSha256);
  assert.deepEqual(
    compatibility.cases,
    RIPGREP_COMPATIBILITY_CASES.map((entry) => ({
      name: entry.name,
      status: entry.code,
      passed: true,
    })),
  );
  assert.equal(materials.status, "complete");
  assert.equal(materials.target, build.target);
  assert.equal(materials.toolchain.commit, pins.rustCommit);
  assert.deepEqual(materials.unprovedScope, []);
  assert.ok(materialFileRecords(materials).length > 0, "Original material files are required");
  assertBinskimSarif(sarif);
}

export async function verifyPublicWindowsCandidate(outputDir) {
  const output = resolve(outputDir);
  const materialsRoot = await realpath(join(output, "materials"));
  const names = [
    "build-evidence.json",
    "compatibility.json",
    "binskim.sarif",
    "materials/materials.json",
    "pcre2-source-evidence.json",
    "pcre2-standard-regression.json",
  ];
  const raw = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readFile(join(output, name))])),
  );
  const build = JSON.parse(raw[names[0]]);
  const compatibility = JSON.parse(raw[names[1]]);
  const sarif = JSON.parse(raw[names[2]]);
  const materials = JSON.parse(raw[names[3]]);
  assertCandidateReports(build, compatibility, materials, sarif);
  const source = JSON.parse(raw["pcre2-source-evidence.json"]);
  assert.equal(sha256(raw["pcre2-source-evidence.json"]), build.source.pcre2.sha256);
  assert.equal(source.version, PCRE2_SOURCE_PINS.version);
  assert.equal(source.archiveSha256, PCRE2_SOURCE_PINS.archiveSha256);
  assert.equal(source.cratePath, "vendor/pcre2-sys");
  const preparedRoot = await realpath(join(build.source.sourceDir, source.cratePath));
  for (const [file, expected] of Object.entries(source.preparedFiles)) {
    assert.ok(!isAbsolute(file) && !file.split(/[\\/]/u).includes(".."));
    const path = await realpath(join(preparedRoot, file));
    const rel = relative(preparedRoot, path);
    assert.ok(
      !isAbsolute(rel) &&
        rel !== ".." &&
        !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
    );
    assert.equal(sha256(await readFile(path)), expected, `Prepared PCRE2 source drift: ${file}`);
  }
  assert.equal(
    sha256(await readFile(join(output, "pcre2-10.49.tar.gz"))),
    PCRE2_SOURCE_PINS.archiveSha256,
  );
  assert.equal(
    sha256(await readFile(join(output, "pcre2-sys-0.2.9.crate"))),
    PCRE2_SOURCE_PINS.crateSha256,
  );
  const regression = JSON.parse(raw["pcre2-standard-regression.json"]);
  assert.deepEqual(regression, build.security.pcre2.standardRegression);
  const junit = await readFile(join(output, "pcre2-ctest.xml"));
  assert.equal(sha256(junit), regression.junit.sha256);
  const inventory = JSON.parse(await readFile(join(output, "pcre2-ctest-inventory.json"), "utf8"));
  assert.deepEqual(
    assertPcre2StandardTests(
      inventory.tests.map((entry) => entry.name),
      junit.toString("utf8"),
    ),
    regression.tests,
  );
  assert.equal(sha256(await readFile(join(output, "pcre2-ctest.log"))), regression.log.sha256);
  const upstream = await readFile(join(output, "upstream-test.log"));
  assert.equal(sha256(upstream), build.security.pcre2.upstreamTests.sha256);
  assert.match(upstream.toString("utf8"), /test result: ok\./u);
  assert.doesNotMatch(upstream.toString("utf8"), /test result: FAILED|error: test failed/u);
  assert.equal(materials.inputs.buildManifest.sha256, sha256(raw[names[0]]));
  const originalManifest = await readFile(join(output, "rust-channel-manifest.toml"));
  assert.equal(sha256(originalManifest), pins.rustManifestSha256);
  const officialComponents = readRustManifestComponents(
    originalManifest.toString("utf8"),
    build.target,
  );
  assert.deepEqual(build.toolchain.componentHashes, officialComponents);
  const installedManifest = await readFile(join(output, "installed-channel-manifest.toml"));
  assert.equal(sha256(installedManifest), build.toolchain.installedManifestSha256);
  assert.deepEqual(
    readRustManifestComponents(installedManifest.toString("utf8"), build.target),
    build.toolchain.componentHashes,
  );
  const compiler = build.toolchain.officialCompiler;
  const officialCompiler = officialComponents.find(
    (entry) => entry.component === `pkg.rustc.target.${build.target}`,
  );
  assert.equal(compiler.archive.sha256, officialCompiler.sha256);
  assert.equal(compiler.archive.url, officialCompiler.url);
  assert.equal(
    sha256(await readFile(join(output, "official-rustc-component.tar.xz"))),
    officialCompiler.sha256,
  );
  assert.ok(compiler.files.some((entry) => entry.path === "bin/rustc.exe"));
  assert.ok(compiler.files.some((entry) => /rustc_driver.*\.dll$/u.test(entry.path)));
  for (const file of compiler.files) {
    assert.ok(!isAbsolute(file.path) && !file.path.split(/[\\/]/u).includes(".."));
    assert.equal(sha256(await readFile(join(build.toolchain.sysroot, file.path))), file.sha256);
  }
  assert.equal(
    compiler.files.find((entry) => entry.path === "bin/rustc.exe").sha256,
    build.toolchain.compilerSha256,
  );
  const buildLog = await readFile(join(output, "cargo-build-messages.jsonl"));
  assert.equal(sha256(buildLog), build.hardening.buildLogSha256);
  const provenance = readBuildProvenance(buildLog.toString("utf8"));
  for (const [key, value] of Object.entries(provenance))
    assert.deepEqual(build.hardening[key], value);
  assert.equal(build.hardening.rebuiltLibraries.length, provenance.linkedArtifacts.length);
  for (const [index, library] of build.hardening.rebuiltLibraries.entries()) {
    assert.equal(library.buildPath, provenance.linkedArtifacts[index]);
    assert.ok(
      library.file.startsWith("rebuilt-std/") && !library.file.split(/[\\/]/u).includes(".."),
    );
    assert.equal(sha256(await readFile(join(output, library.file))), library.sha256);
    assert.equal(sha256(await readFile(library.buildPath)), library.sha256);
  }
  const binary = await readFile(join(output, "rg.exe"));
  assert.equal(sha256(binary), build.outputs.executableSha256);
  const pdb = await readFile(join(output, "rg.pdb"));
  assert.equal(sha256(pdb), build.outputs.pdbSha256);
  assert.deepEqual(assertPePdbBinding(binary, pdb), build.hardening.pdbBinding);
  const zip = await readFile(join(output, build.outputs.archiveName));
  assert.equal(sha256(zip), build.outputs.archiveSha256);
  assert.deepEqual(zip, createDeterministicRipgrepZip(binary));
  assert.deepEqual(
    await verifyPublicWindowsPeHardening(join(output, "rg.exe"), build.arch),
    build.hardening.pe,
  );
  for (const record of materialFileRecords(materials)) {
    if (isAbsolute(record.file))
      throw new Error("Material path must be relative to the sealed output");
    const path = await realpath(resolve(materialsRoot, record.file));
    const rel = relative(materialsRoot, path);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Material path escapes its output directory");
    assert.equal(
      sha256(await readFile(path)),
      record.sha256,
      `Material digest mismatch: ${record.file}`,
    );
  }
  const result = {
    schemaVersion: 1,
    status: "verified-candidate",
    target: build.target,
    workflowCommit: process.env.GITHUB_SHA ?? null,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    outputs: build.outputs,
    reports: Object.fromEntries(Object.entries(raw).map(([name, bytes]) => [name, sha256(bytes)])),
    purpose:
      "Reviewable candidate only; this seal does not publish or promote the release registration.",
  };
  await writeFile(join(output, "verified-candidate.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const arg = process.argv.find((value) => value.startsWith("--output-dir="));
  verifyPublicWindowsCandidate(arg?.slice("--output-dir=".length) ?? "")
    .then((result) => console.log(result.status))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
