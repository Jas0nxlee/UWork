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

export function materialFileRecords(value) {
  if (Array.isArray(value)) return value.flatMap(materialFileRecords);
  if (!value || typeof value !== "object") return [];
  if (typeof value.file === "string" && typeof value.sha256 === "string") return [value];
  return Object.values(value).flatMap(materialFileRecords);
}
export function assertCandidateReports(build, compatibility, materials, sarif) {
  assert.equal(build.status, "built-awaiting-compatibility-and-binskim");
  // 10.43 的可增长 JIT 栈漏洞已确认可达；许可/硬化齐全不能让未修复基线获得封存。
  const advisory = build.security?.pcre2?.advisories?.find(
    (entry) => entry.id === "GHSA-r9hj-j2rw-4q3m",
  );
  assert.equal(advisory?.status, "patched", "GHSA-r9hj-j2rw-4q3m requires the official backport");
  assert.equal(
    advisory?.regressionStatus,
    "passed",
    "GHSA-r9hj-j2rw-4q3m requires native failing-before/passing-after PoC evidence",
  );
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
  assert.equal(compatibility.nativePlatform, "win32");
  assert.equal(compatibility.nativeArch, build.arch);
  assert.equal(compatibility.cases.length, 11);
  assert.equal(
    compatibility.cases.every((entry) => entry.passed === true),
    true,
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
  ];
  const raw = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readFile(join(output, name))])),
  );
  const build = JSON.parse(raw[names[0]]);
  const compatibility = JSON.parse(raw[names[1]]);
  const sarif = JSON.parse(raw[names[2]]);
  const materials = JSON.parse(raw[names[3]]);
  assertCandidateReports(build, compatibility, materials, sarif);
  assert.equal(materials.inputs.buildManifest.sha256, sha256(raw[names[0]]));
  const installedManifest = await readFile(join(output, "installed-channel-manifest.toml"));
  assert.equal(sha256(installedManifest), build.toolchain.installedManifestSha256);
  assert.deepEqual(
    readRustManifestComponents(installedManifest.toString("utf8"), build.target),
    build.toolchain.componentHashes,
  );
  const binary = await readFile(join(output, "rg.exe"));
  assert.equal(sha256(binary), build.outputs.executableSha256);
  assert.equal(sha256(await readFile(join(output, "rg.pdb"))), build.outputs.pdbSha256);
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
