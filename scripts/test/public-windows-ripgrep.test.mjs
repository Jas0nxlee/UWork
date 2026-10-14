import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS,
  createPublicWindowsRipgrepPlan,
  stripPrivateCargoRegistry,
  assertRustCompilerIdentity,
} from "../public-windows-ripgrep-plan.mjs";

test("the Windows candidate requires native matching architecture and std rebuild", () => {
  for (const arch of ["x64", "arm64"]) {
    const plan = createPublicWindowsRipgrepPlan({ arch, hostPlatform: "win32", hostArch: arch });
    assert.equal(plan.toolchain, "nightly-2025-06-26");
    assert.ok(plan.cargoBuildArgs.includes("-Zbuild-std=std,panic_unwind"));
    assert.ok(plan.cargoBuildArgs.includes("--locked"));
    assert.ok(plan.rustFlags.includes("-Ccontrol-flow-guard=yes"));
    assert.ok(plan.rustFlags.includes("-Ctarget-feature=+crt-static"));
    assert.equal(
      plan.rustFlags.some((flag) => flag.includes("nochecks")),
      false,
    );
    assert.equal(
      plan.rustFlags.some((flag) => flag.includes("/CETCOMPAT")),
      arch === "x64",
    );
    assert.match(plan.cflags, /\/guard:cf.*\/Qspectre/u);
  }
  assert.throws(
    () => createPublicWindowsRipgrepPlan({ arch: "arm64", hostPlatform: "win32", hostArch: "x64" }),
    /native/u,
  );
  assert.throws(
    () => createPublicWindowsRipgrepPlan({ arch: "x64", hostPlatform: "darwin", hostArch: "x64" }),
    /Windows/u,
  );
  assert.throws(
    () =>
      createPublicWindowsRipgrepPlan({
        arch: "x64",
        hostPlatform: "win32",
        hostArch: "x64",
        env: { RUSTC_BOOTSTRAP: "1" },
      }),
    /BOOTSTRAP/u,
  );
});

test("only the private registry redirect is removed from the original Microsoft patch", () => {
  const config = `[target.'cfg(target_os = "windows")'.source.crates-io]\nreplace-with = 'ms-crates-io'\n\n[registries.ms-crates-io]\nindex = "sparse+https://pkgs.dev.azure.com/monacotools/Monaco/_packaging/ripgrep-prebuilt-crates/Cargo/index/"\n\n[target.'cfg(target_os = "windows")']\nrustflags = ["-Ccontrol-flow-guard", "-Ctarget-feature=+crt-static", "/DYNAMICBASE /CETCOMPAT"]\n`;
  const result = stripPrivateCargoRegistry(config);
  assert.doesNotMatch(result, /ms-crates-io|pkgs\.dev\.azure/u);
  assert.match(result, /control-flow-guard/u);
  assert.match(result, /crt-static/u);
  assert.throws(
    () => stripPrivateCargoRegistry(config + '\n[registry]\nindex = "https://private.invalid"'),
    /Unexpected/u,
  );
});

test("compiler identity is bound to the dated public channel full commit", () => {
  const valid = `rustc ${PUBLIC_WINDOWS_RIPGREP_PINS.rustRelease}\ncommit-hash: ${PUBLIC_WINDOWS_RIPGREP_PINS.rustCommit}\nhost: x86_64-pc-windows-msvc\nrelease: ${PUBLIC_WINDOWS_RIPGREP_PINS.rustRelease}\n`;
  assert.doesNotThrow(() => assertRustCompilerIdentity(valid, "x86_64-pc-windows-msvc"));
  assert.throws(
    () =>
      assertRustCompilerIdentity(
        valid.replace(PUBLIC_WINDOWS_RIPGREP_PINS.rustCommit, "0".repeat(40)),
        "x86_64-pc-windows-msvc",
      ),
    /commit/u,
  );
  assert.throws(() => assertRustCompilerIdentity(valid, "aarch64-pc-windows-msvc"), /host/u);
});

const { assertPublicWindowsPeHardening } = await import("../public-windows-ripgrep-hardening.mjs");
test("candidate hardening cannot pass from an architecture label or CFG metadata without enforcement", () => {
  const base = {
    machine: 0x8664,
    dllCharacteristics: 0xc160,
    guardFlags: 0x10017500,
    securityCookie: "1",
    guardCheckFunction: "1",
    guardDispatchFunction: "1",
    guardFunctionTable: "1",
    guardFunctionCount: "10",
    extendedDllCharacteristics: 1,
  };
  assert.doesNotThrow(() => assertPublicWindowsPeHardening(base, "x64"));
  assert.doesNotThrow(() =>
    assertPublicWindowsPeHardening(
      { ...base, machine: 0xaa64, extendedDllCharacteristics: 0 },
      "arm64",
    ),
  );
  for (const mutation of [
    { dllCharacteristics: 0x160 },
    { guardFlags: 0x400 },
    { guardFlags: 0x500 },
    { guardCheckFunction: "0" },
    { guardFunctionCount: "0" },
    { securityCookie: "0" },
    { extendedDllCharacteristics: 0 },
  ]) {
    assert.throws(() => assertPublicWindowsPeHardening({ ...base, ...mutation }, "x64"));
  }
});

const { crc32, createDeterministicRipgrepZip } =
  await import("../public-windows-ripgrep-archive.mjs");
const { inflateRawSync } = await import("node:zlib");
test("candidate ZIP is a deterministic single rg.exe member with a verified CRC", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const binary = Buffer.from("MZ candidate fixture 中文");
  const first = createDeterministicRipgrepZip(binary);
  assert.deepEqual(first, createDeterministicRipgrepZip(binary));
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.toString("utf8", 30, 36), "rg.exe");
  assert.deepEqual(inflateRawSync(first.subarray(36, 36 + first.readUInt32LE(18))), binary);
  assert.equal(first.readUInt32LE(14), crc32(binary));
  assert.equal(first.readUInt16LE(first.length - 12), 1);
});

const { assertBinskimSarif } = await import("../run-public-windows-ripgrep-binskim.mjs");
test("BinSkim failures, reviews, invocation errors and an empty analysis cannot pass", () => {
  const valid = {
    runs: [
      {
        artifacts: [{ location: { uri: "file:///candidate/rg.exe" } }],
        invocations: [{ executionSuccessful: true }],
        results: [],
      },
    ],
  };
  assert.doesNotThrow(() => assertBinskimSarif(valid));
  for (const result of [
    { kind: "fail", level: "error", ruleId: "BA2019" },
    { kind: "review", level: "note", ruleId: "BA9999" },
  ])
    assert.throws(() => assertBinskimSarif({ runs: [{ ...valid.runs[0], results: [result] }] }));
  assert.throws(() => assertBinskimSarif({ runs: [] }));
  assert.throws(() => assertBinskimSarif({ runs: [{ ...valid.runs[0], artifacts: [] }] }));
  assert.throws(() =>
    assertBinskimSarif({
      runs: [{ ...valid.runs[0], invocations: [{ executionSuccessful: false }] }],
    }),
  );
});

const { assertCandidateReports } = await import("../verify-public-windows-ripgrep-candidate.mjs");
test("the final candidate seal rejects incomplete runtime material and unverified reports", () => {
  const p = PUBLIC_WINDOWS_RIPGREP_PINS;
  const build = {
    status: "built-awaiting-compatibility-and-binskim",
    arch: "x64",
    target: "x86_64-pc-windows-msvc",
    source: { revision: p.sourceCommit },
    security: {
      pcre2: {
        version: "10.43",
        advisories: [{ id: "GHSA-r9hj-j2rw-4q3m", status: "patched", regressionStatus: "passed" }],
      },
    },
    toolchain: { commit: p.rustCommit, manifestSha256: p.rustManifestSha256 },
    hardening: {
      stdRebuildRequired: true,
      panicStrategy: "unwind",
      rustcBootstrap: false,
      stdArtifact: { fresh: false },
      panicArtifact: { target: { name: "panic_unwind" } },
    },
  };
  const compatibility = {
    nativePlatform: "win32",
    nativeArch: "x64",
    cases: Array.from({ length: 11 }, () => ({ passed: true })),
  };
  const materials = {
    status: "complete",
    target: build.target,
    toolchain: { commit: p.rustCommit },
    unprovedScope: [],
    rustNotices: [{ file: "rust/LICENSE", sha256: "0".repeat(64) }],
  };
  const sarif = { runs: [{ artifacts: [{ location: { uri: "rg.exe" } }], results: [] }] };
  assert.doesNotThrow(() => assertCandidateReports(build, compatibility, materials, sarif));
  for (const security of [
    undefined,
    { pcre2: { version: "10.43", advisories: [] } },
    {
      pcre2: {
        version: "10.43",
        advisories: [
          { id: "GHSA-r9hj-j2rw-4q3m", status: "baseline-unpatched", regressionStatus: "not-run" },
        ],
      },
    },
    {
      pcre2: {
        version: "10.43",
        advisories: [{ id: "GHSA-r9hj-j2rw-4q3m", status: "patched", regressionStatus: "not-run" }],
      },
    },
  ])
    assert.throws(
      () => assertCandidateReports({ ...build, security }, compatibility, materials, sarif),
      /GHSA-r9hj-j2rw-4q3m/u,
    );
  assert.throws(() =>
    assertCandidateReports(
      build,
      compatibility,
      { ...materials, unprovedScope: ["CRT not proved"] },
      sarif,
    ),
  );
  assert.throws(() =>
    assertCandidateReports(build, { ...compatibility, nativeArch: "arm64" }, materials, sarif),
  );
  assert.throws(() =>
    assertCandidateReports(
      { ...build, status: "source-prepared-only" },
      compatibility,
      materials,
      sarif,
    ),
  );
});
