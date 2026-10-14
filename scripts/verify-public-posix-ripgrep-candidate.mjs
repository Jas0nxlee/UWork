#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as sourcePins,
  assertSha256,
  sha256,
} from "./public-windows-ripgrep-plan.mjs";
import {
  PUBLIC_POSIX_RIPGREP_PINS as pins,
  createPublicPosixRipgrepPlan,
  assertPosixPlatformReports,
} from "./public-posix-ripgrep-plan.mjs";
import { PCRE2_SOURCE_PINS as pcrePins, execute } from "./public-windows-ripgrep-source.mjs";
import { createDeterministicPosixArchive } from "./build-public-posix-ripgrep.mjs";
import {
  RIPGREP_COMPATIBILITY_CASES,
  runRipgrepCompatibility,
} from "./public-ripgrep-compatibility.mjs";
import {
  NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS,
  NATIVE_SEARCH_DEPENDENCIES_DIR,
} from "./native-search-tools-config.mjs";

import {
  checkedCandidateFile,
  verifyPreparedSources,
  verifyRustComponents,
  verifyMaterials,
  assertPosixCargoGraph,
  createPosixSealMetadataEnv,
} from "./public-posix-ripgrep-seal-inputs.mjs";
export {
  checkedCandidateFile,
  assertPosixCargoGraph,
} from "./public-posix-ripgrep-seal-inputs.mjs";

export function assertPosixCandidateReports(
  build,
  compatibility,
  materials,
  source,
  native = process,
) {
  const plan = createPublicPosixRipgrepPlan({
    platform: build.plan?.platform,
    arch: build.plan?.arch,
    hostPlatform: native.platform,
    hostArch: native.arch,
    env: {},
  });
  assert.deepEqual(build.plan, plan, "Candidate plan differs from fixed native contract");
  assert.equal(build.schemaVersion, 1);
  assert.equal(build.status, "native-candidate-awaiting-independent-seal");
  assert.equal(build.promotion, "not-performed");
  assert.equal(build.source.revision, sourcePins.sourceCommit);
  assert.equal(build.source.archiveSha256, sourcePins.sourceSha256);
  for (const [key, expected] of Object.entries(pins))
    assert.deepEqual(build.toolchain[key], expected, `Public Rust pin mismatch: ${key}`);
  assert.equal(build.toolchain.identity.release, pins.toolchain);
  assert.equal(build.toolchain.identity["commit-hash"], pins.rustCommit);
  assert.equal(build.toolchain.identity.host, plan.host);
  assert.equal(source.version, pcrePins.version);
  assert.equal(source.archiveSha256, pcrePins.archiveSha256);
  assert.equal(source.crateSha256, pcrePins.crateSha256);
  assert.equal(source.cratePath, "vendor/pcre2-sys");
  assert.equal(source.cargo.lockSha256, build.source.cargoLockSha256);
  assert.deepEqual(build.security.pcre2, {
    version: pcrePins.version,
    validation: "official-post-update-standard-suite-only",
    independentPoc: "not-run",
  });
  assert.equal(build.reports.pcre2Standard.status, "passed");
  assert.equal(build.reports.pcre2Standard.version, pcrePins.version);
  assert.equal(build.reports.pcre2Standard.file, "pcre2-test.log");
  assert.deepEqual(build.reports.pcre2Standard.command, ["make", "check"]);
  assert.deepEqual(build.reports.pcre2Standard.testNames, [
    "pcre2posix_test",
    "pcre2_jit_test",
    "RunTest",
    "RunGrepTest",
  ]);
  assert.equal(build.reports.upstream.file, "upstream-test.log");
  assert.equal(build.reports.upstream.status, "passed");
  assert.deepEqual(build.reports.upstream.command, plan.testArgs);
  for (const report of [build.reports.upstream, build.reports.pcre2Standard]) {
    assert.equal(report.exitCode, 0, "Normal upstream suite must finish with exit 0");
    assert.equal(report.nativePlatform, native.platform);
    assert.equal(report.nativeArch, native.arch);
  }
  assert.equal(compatibility.nativePlatform, native.platform);
  assert.equal(compatibility.nativeArch, native.arch);
  assert.equal(compatibility.candidateSha256, build.outputs.executableSha256);
  assert.deepEqual(
    compatibility.cases,
    RIPGREP_COMPATIBILITY_CASES.map((entry) => ({
      name: entry.name,
      status: entry.code,
      passed: true,
    })),
  );
  assert.equal(materials.schemaVersion, 1);
  assert.equal(materials.status, "candidate-materials-collected");
  assert.equal(materials.target, plan.target);
  assert.deepEqual(materials.toolchain, pins);
  assert.deepEqual(materials.unprovedScope, []);
  assert.equal(
    build.outputs.archiveName,
    `ripgrep-v14.1.1-uwork-pcre2-10.49-1-${plan.target}.tar.gz`,
  );
  for (const hash of [build.outputs.executableSha256, build.outputs.archiveSha256])
    assert.match(hash, /^[a-f0-9]{64}$/u);
  return plan;
}

export function assertPosixStandardTests(upstream, pcre) {
  const results = [
    ...upstream.matchAll(
      /test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/gu,
    ),
  ];
  assert.ok(results.length > 0, "Missing actual upstream test summaries");
  let upstreamTests = 0;
  let ignoredTotal = 0;
  for (const result of results) {
    upstreamTests += Number(result[1]);
    ignoredTotal += Number(result[3]);
    assert.equal(Number(result[2]), 0, "Upstream test failure");
    assert.equal(Number(result[5]), 0, "Upstream filtered tests");
  }
  const upstreamIgnored = [...upstream.matchAll(/^test ([^\s]+) \.\.\. ignored\s*$/gmu)].map(
    (m) => m[1],
  );
  // 固定上游源码已有此唯一未实现测试；精确绑定名称与计数，不能把新增忽略当作通过。
  assert.deepEqual(upstreamIgnored, ignoredTotal === 1 ? ["matcher::tests::candidate_lines"] : []);
  assert.equal(upstreamIgnored.length, ignoredTotal, "Unexpected upstream ignored tests");
  assert.ok(upstreamTests > 0, "No upstream tests executed");
  assert.doesNotMatch(upstream, /test result: FAILED|error: test failed|panicked at/u);
  const expected = ["pcre2posix_test", "pcre2_jit_test", "RunTest", "RunGrepTest"];
  assert.deepEqual(
    [...pcre.matchAll(/^PASS: (.+)$/gmu)].map((m) => m[1]).sort(),
    [...expected].sort(),
    "PCRE2 standard suite inventory mismatch",
  );
  for (const [label, count] of Object.entries({
    TOTAL: 4,
    PASS: 4,
    SKIP: 0,
    XFAIL: 0,
    FAIL: 0,
    XPASS: 0,
    ERROR: 0,
  })) {
    const values = [...pcre.matchAll(new RegExp(`^# ${label}:\\s+(\\d+)\\s*$`, "gmu"))];
    assert.equal(values.length, 1, `Missing or duplicate PCRE2 ${label} total`);
    assert.equal(Number(values[0][1]), count, `PCRE2 ${label} count mismatch`);
  }
  assert.doesNotMatch(pcre, /^(?:FAIL|SKIP|ERROR|XFAIL|XPASS):/mu);
  return { upstreamTests, upstreamIgnored, pcre2Suites: expected.length };
}

export async function verifyPublicPosixCandidate(outputDir) {
  assert.ok(outputDir, "--output-dir is required");
  const output = await realpath(resolve(outputDir));
  const sealPath = join(output, "verified-candidate.json");
  await rm(sealPath, { force: true });
  const temporary = await mkdtemp(join(tmpdir(), "posix-ripgrep-seal-"));
  const verified = {};
  const input = async (file) => {
    const bytes = await readFile(await checkedCandidateFile(output, file));
    verified[file] = sha256(bytes);
    return bytes;
  };
  try {
    const build = JSON.parse(await input("build-evidence.json"));
    const compatibility = JSON.parse(await input("compatibility.json"));
    const materials = JSON.parse(await input("materials/materials.json"));
    const source = JSON.parse(await input("pcre2-source-evidence.json"));
    const plan = assertPosixCandidateReports(build, compatibility, materials, source);
    const workRoot = await realpath(build.source.workDir);
    assert.equal(await realpath(build.source.sourceDir), await realpath(join(workRoot, "source")));
    assert.equal(
      await realpath(build.toolchain.prefix),
      await realpath(join(workRoot, "toolchain")),
    );
    assert.deepEqual(build.source.archive, {
      file: "ripgrep-source.tar.gz",
      sha256: sourcePins.sourceSha256,
    });
    assert.deepEqual(
      build.source.posixProducer,
      pins.producerSources.map((item) => ({
        file: `microsoft-posix-${item.path.replaceAll("/", "-")}`,
        source: `https://raw.githubusercontent.com/microsoft/ripgrep-prebuilt/${sourcePins.microsoftProducer}/${item.path}`,
        sha256: item.sha256,
      })),
    );
    for (const record of build.source.posixProducer)
      assertSha256(await input(record.file), record.sha256, record.file);
    assert.equal(verified["pcre2-source-evidence.json"], build.source.pcre2.sha256);
    for (const report of Object.values(build.reports)) {
      assert.ok(
        report.file && /^[a-f0-9]{64}$/u.test(report.sha256),
        "Report requires a sealed file digest",
      );
      assertSha256(await input(report.file), report.sha256, report.file);
    }
    assert.deepEqual(
      Object.keys(materials.inputs).sort(),
      [
        "Cargo.lock",
        "cargo-metadata.json",
        "cargo-build-messages.jsonl",
        "rustc-vv.txt",
        "pcre2-source-evidence.json",
      ].sort(),
      "Missing license input bindings",
    );
    for (const [file, hash] of Object.entries(materials.inputs))
      assertSha256(await input(file), hash, `Material input ${file}`);
    for (const file of [
      "rust-channel-manifest.toml",
      "ripgrep-source.tar.gz",
      "microsoft-binskim.patch",
      "pcre2-10.49.tar.gz",
      "pcre2-sys-0.2.9.crate",
      ...build.toolchain.components.map((c) => c.file),
    ])
      await input(file);
    assertSha256(await input("Cargo.lock"), build.source.cargoLockSha256, "Built Cargo lock");
    const binary = await input("rg");
    assertSha256(binary, build.outputs.executableSha256, "Candidate binary");
    const archive = await input(build.outputs.archiveName);
    assertSha256(archive, build.outputs.archiveSha256, "Candidate archive");
    assert.deepEqual(
      archive,
      await createDeterministicPosixArchive(binary),
      "Archive must contain exactly the verified executable with original mode",
    );
    const platformReports =
      plan.platform === "darwin"
        ? {
            loadCommands: await execute("otool", ["-l", join(output, "rg")], { capture: true }),
            dependencies: await execute("otool", ["-L", join(output, "rg")], { capture: true }),
          }
        : {
            programHeaders: await execute("readelf", ["-l", join(output, "rg")], { capture: true }),
            dynamic: await execute("readelf", ["-d", join(output, "rg")], { capture: true }),
            versions: await execute("readelf", ["--version-info", join(output, "rg")], {
              capture: true,
            }),
          };
    assertPosixPlatformReports(plan, binary, platformReports);
    const sourceRoot = await verifyPreparedSources(output, build, source, temporary);
    const originalRustNotices = await verifyRustComponents(output, build, plan, temporary);
    const metadata = JSON.parse(await input("cargo-metadata.json"));
    const actualMetadata = JSON.parse(
      await execute(
        join(build.toolchain.prefix, "bin/cargo"),
        [
          "metadata",
          "--format-version",
          "1",
          "--locked",
          "--offline",
          "--features",
          "pcre2",
          "--filter-platform",
          plan.target,
        ],
        {
          cwd: sourceRoot,
          env: createPosixSealMetadataEnv(build.toolchain.prefix, workRoot),
          capture: true,
        },
      ),
    );
    assert.deepEqual(
      metadata,
      actualMetadata,
      "Actual offline Cargo resolve graph differs from sealed metadata",
    );
    assert.deepEqual(await readFile(join(sourceRoot, "Cargo.lock")), await input("Cargo.lock"));
    const messages = (await input("cargo-build-messages.jsonl"))
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    const actual = assertPosixCargoGraph(metadata, messages, materials, plan.target);
    assert.deepEqual(
      await readFile(actual.executable),
      binary,
      "Cargo compiler output differs from candidate",
    );
    const tests = assertPosixStandardTests(
      (await input("upstream-test.log")).toString("utf8"),
      (await input("pcre2-test.log")).toString("utf8"),
    );
    await verifyMaterials(output, build, materials, metadata, sourceRoot, originalRustNotices);
    const baseline = NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS[`${plan.platform}-${plan.arch}`];
    const baselineArchive = join(
      NATIVE_SEARCH_DEPENDENCIES_DIR,
      `ripgrep-v14.1.1-1/${baseline.releaseFileName}`,
    );
    assertSha256(
      await readFile(baselineArchive),
      baseline.sha256,
      "Ordinary compatibility baseline archive",
    );
    const baselineDir = join(temporary, "baseline");
    await mkdir(baselineDir);
    await execute("tar", ["-xzf", baselineArchive, "-C", baselineDir], { capture: true });
    assert.equal(compatibility.baselineArchiveSha256, baseline.sha256);
    assertSha256(
      await readFile(join(baselineDir, "rg")),
      compatibility.baselineExecutableSha256,
      "Compatibility baseline executable",
    );
    const cases = await runRipgrepCompatibility({
      candidate: join(output, "rg"),
      baseline: join(baselineDir, "rg"),
      fixtureDir: join(temporary, "compatibility"),
      requireJit: plan.jit,
    });
    assert.deepEqual(
      cases,
      compatibility.cases,
      "Independent native compatibility result mismatch",
    );
    const result = {
      schemaVersion: 1,
      status: "verified-candidate",
      target: plan.target,
      nativePlatform: process.platform,
      nativeArch: process.arch,
      workflowCommit: process.env.GITHUB_SHA ?? null,
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      outputs: build.outputs,
      inputs: verified,
      tests,
      compatibility: cases,
      security: {
        version: pcrePins.version,
        archiveSha256: pcrePins.archiveSha256,
        acceptance: "official-updated-source-standard-tests-and-native-cli",
        independentPoc: "not-run",
      },
      promotion: "not-performed",
    };
    const pending = join(output, "verified-candidate.json.tmp");
    await writeFile(pending, JSON.stringify(result, null, 2) + "\n");
    await rename(pending, sealPath);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const option = process.argv.find((arg) => arg.startsWith("--output-dir="));
  verifyPublicPosixCandidate(option?.slice("--output-dir=".length))
    .then((result) => console.log(result.status))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
