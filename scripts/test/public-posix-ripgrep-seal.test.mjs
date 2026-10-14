import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  assertPosixCandidateReports,
  assertPosixStandardTests,
  assertPosixCargoGraph,
  checkedCandidateFile,
  verifyPublicPosixCandidate,
} from "../verify-public-posix-ripgrep-candidate.mjs";
import {
  PUBLIC_POSIX_RIPGREP_PINS as pins,
  createPublicPosixRipgrepPlan,
} from "../public-posix-ripgrep-plan.mjs";
import { PCRE2_SOURCE_PINS } from "../public-windows-ripgrep-source.mjs";
import { RIPGREP_COMPATIBILITY_CASES } from "../public-ripgrep-compatibility.mjs";
import { PUBLIC_WINDOWS_RIPGREP_PINS as sourcePins } from "../public-windows-ripgrep-plan.mjs";
import {
  createPosixSealMetadataEnv,
  readPosixCommonLicenseOriginals,
} from "../public-posix-ripgrep-seal-inputs.mjs";

function reports() {
  const plan = createPublicPosixRipgrepPlan({
    platform: "linux",
    arch: "x64",
    hostPlatform: "linux",
    hostArch: "x64",
    env: {},
  });
  const build = {
    schemaVersion: 1,
    status: "native-candidate-awaiting-independent-seal",
    plan,
    source: {
      revision: sourcePins.sourceCommit,
      archiveSha256: sourcePins.sourceSha256,
      cargoLockSha256: "a".repeat(64),
      pcre2: { file: "pcre2-source-evidence.json", sha256: "b".repeat(64) },
    },
    toolchain: {
      ...pins,
      identity: { release: pins.toolchain, "commit-hash": pins.rustCommit, host: plan.host },
    },
    outputs: {
      executableSha256: "c".repeat(64),
      archiveSha256: "d".repeat(64),
      archiveName: `ripgrep-v14.1.1-uwork-pcre2-10.49-1-${plan.target}.tar.gz`,
    },
    reports: {
      pcre2Standard: {
        status: "passed",
        version: "10.49",
        file: "pcre2-test.log",
        sha256: "e".repeat(64),
        exitCode: 0,
        command: ["make", "check"],
        nativePlatform: "linux",
        nativeArch: "x64",
        testNames: ["pcre2posix_test", "pcre2_jit_test", "RunTest", "RunGrepTest"],
      },
      upstream: {
        status: "passed",
        exitCode: 0,
        command: plan.testArgs,
        nativePlatform: "linux",
        nativeArch: "x64",
        file: "upstream-test.log",
        sha256: "f".repeat(64),
      },
    },
    security: {
      pcre2: {
        version: "10.49",
        validation: "official-post-update-standard-suite-only",
        independentPoc: "not-run",
      },
    },
    promotion: "not-performed",
  };
  const compatibility = {
    nativePlatform: "linux",
    nativeArch: "x64",
    candidateSha256: build.outputs.executableSha256,
    cases: RIPGREP_COMPATIBILITY_CASES.map((c) => ({ name: c.name, status: c.code, passed: true })),
  };
  const materials = {
    schemaVersion: 1,
    status: "candidate-materials-collected",
    target: plan.target,
    toolchain: pins,
    unprovedScope: [],
  };
  const source = {
    version: PCRE2_SOURCE_PINS.version,
    archiveSha256: PCRE2_SOURCE_PINS.archiveSha256,
    crateSha256: PCRE2_SOURCE_PINS.crateSha256,
    cratePath: "vendor/pcre2-sys",
    cargo: { lockSha256: build.source.cargoLockSha256 },
  };
  return { build, compatibility, materials, source };
}

test("report contract requires exact public source/toolchain/native target and all ordinary cases", () => {
  const r = reports();
  assert.doesNotThrow(() =>
    assertPosixCandidateReports(r.build, r.compatibility, r.materials, r.source, {
      platform: "linux",
      arch: "x64",
    }),
  );
  const mutations = [
    (x) => {
      x.build.plan.target = "aarch64-unknown-linux-musl";
    },
    (x) => {
      x.build.toolchain.identity["commit-hash"] = "0".repeat(40);
    },
    (x) => {
      x.source.archiveSha256 = "0".repeat(64);
    },
    (x) => {
      x.source.version = "10.43";
    },
    (x) => {
      x.build.security.pcre2.independentPoc = "passed";
    },
    (x) => {
      x.compatibility.cases.pop();
    },
    (x) => {
      x.compatibility.cases[0].status = 2;
    },
    (x) => {
      x.compatibility.candidateSha256 = "0".repeat(64);
    },
    (x) => {
      x.materials.unprovedScope.push("missing-original");
    },
    (x) => {
      x.materials.target = "aarch64-unknown-linux-musl";
    },
    (x) => {
      x.build.reports.upstream.exitCode = 1;
    },
    (x) => {
      x.build.reports.upstream.command = ["test", "--no-run"];
    },
    (x) => {
      x.build.reports.pcre2Standard.testNames.pop();
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(r);
    mutate(changed);
    assert.throws(() =>
      assertPosixCandidateReports(
        changed.build,
        changed.compatibility,
        changed.materials,
        changed.source,
        { platform: "linux", arch: "x64" },
      ),
    );
  }
  assert.throws(
    () =>
      assertPosixCandidateReports(r.build, r.compatibility, r.materials, r.source, {
        platform: "linux",
        arch: "arm64",
      }),
    /native/u,
  );
});

test("standard suite raw logs require actual executed tests and reject omitted, ignored or failed suites", () => {
  const upstream =
    "running 12 tests\ntest result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1s\n";
  const pcre =
    "PASS: pcre2posix_test\nPASS: pcre2_jit_test\nPASS: RunTest\nPASS: RunGrepTest\n# TOTAL: 4\n# PASS: 4\n# SKIP: 0\n# XFAIL: 0\n# FAIL: 0\n# XPASS: 0\n# ERROR: 0\n";
  assert.deepEqual(assertPosixStandardTests(upstream, pcre), {
    upstreamTests: 12,
    upstreamIgnored: [],
    pcre2Suites: 4,
  });
  const originalIgnored =
    "test matcher::tests::candidate_lines ... ignored\n" +
    upstream.replace("0 ignored", "1 ignored");
  assert.deepEqual(assertPosixStandardTests(originalIgnored, pcre).upstreamIgnored, [
    "matcher::tests::candidate_lines",
  ]);
  assert.throws(() =>
    assertPosixStandardTests(originalIgnored.replace("candidate_lines", "new_skip"), pcre),
  );
  assert.throws(() =>
    assertPosixStandardTests(originalIgnored.replace("1 ignored", "2 ignored"), pcre),
  );
  for (const invalid of [
    "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    upstream.replace("0 failed", "1 failed"),
    upstream.replace("0 ignored", "1 ignored"),
    upstream + "error: test failed\n",
  ])
    assert.throws(() => assertPosixStandardTests(invalid, pcre));
  for (const invalid of [
    pcre.replace("PASS: RunTest", "SKIP: RunTest"),
    pcre.replace("# FAIL: 0", "# FAIL: 1"),
    pcre.replace("# TOTAL: 4", "# TOTAL: 3"),
    pcre + "FAIL: extra\n",
  ])
    assert.throws(() => assertPosixStandardTests(upstream, invalid));
});

function cargoFixture() {
  const pkg = (id, name, source = null) => ({
    id,
    name,
    version: name === "pcre2-sys" ? "0.2.9" : "1.0.0",
    source,
    manifest_path: `/source/${name}/Cargo.toml`,
  });
  const metadata = {
    packages: [
      pkg("rg", "ripgrep"),
      pkg("sys", "pcre2-sys"),
      pkg("dep", "cc", "registry+https://github.com/rust-lang/crates.io-index"),
    ],
    resolve: {
      nodes: [
        { id: "rg", deps: [{ pkg: "sys", dep_kinds: [{ kind: null }] }] },
        { id: "sys", deps: [{ pkg: "dep", dep_kinds: [{ kind: "build" }] }] },
        { id: "dep", deps: [] },
      ],
    },
  };
  const artifact = (package_id, name, kind = "lib", filenames = []) => ({
    reason: "compiler-artifact",
    package_id,
    fresh: false,
    target: { name, kind: [kind] },
    filenames,
    executable: kind === "bin" ? filenames[0] : null,
  });
  const messages = [
    artifact("dep", "cc"),
    artifact("sys", "pcre2_sys"),
    artifact("sys", "build-script-build", "custom-build"),
    {
      reason: "build-script-executed",
      package_id: "sys",
      linked_libs: ["static=pcre2"],
      out_dir: "/target/release/build/pcre2/out",
    },
    artifact("rg", "rg", "bin", ["/target/x86_64-unknown-linux-musl/release/rg"]),
    { reason: "build-finished", success: true },
  ];
  const materials = {
    packages: metadata.packages.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      notices: [{ file: `cargo/${p.name}/LICENSE`, sha256: "a".repeat(64) }],
      archiveSha256: p.source ? "b".repeat(64) : undefined,
    })),
  };
  return { metadata, messages, materials };
}

test("actual Cargo graph covers every built crate, fresh binary and static PCRE2 link", () => {
  const r = cargoFixture();
  assert.equal(
    assertPosixCargoGraph(r.metadata, r.messages, r.materials, "x86_64-unknown-linux-musl")
      .executable,
    "/target/x86_64-unknown-linux-musl/release/rg",
  );
  for (const mutate of [
    (x) => {
      x.materials.packages.pop();
    },
    (x) => {
      x.materials.packages[0].notices = [];
    },
    (x) => {
      x.messages[0].package_id = "outside";
    },
    (x) => {
      x.messages[4].fresh = true;
    },
    (x) => {
      x.messages[3].linked_libs = ["dylib=pcre2-8"];
    },
    (x) => {
      x.messages.at(-1).success = false;
    },
  ]) {
    const copy = structuredClone(r);
    mutate(copy);
    assert.throws(() =>
      assertPosixCargoGraph(
        copy.metadata,
        copy.messages,
        copy.materials,
        "x86_64-unknown-linux-musl",
      ),
    );
  }
});

test("sealed file paths reject traversal, absolute paths and symlinks escaping artifact root", async () => {
  const root = await mkdtemp(join(tmpdir(), "posix-seal-path-"));
  try {
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, "artifacts", "inside"), "original");
    await writeFile(join(root, "outside"), "different");
    await symlink(join(root, "outside"), join(root, "artifacts", "escape"));
    assert.match(await checkedCandidateFile(join(root, "artifacts"), "inside"), /inside$/u);
    for (const file of ["../outside", join(root, "outside"), "escape", "nested/../../outside"])
      await assert.rejects(() => checkedCandidateFile(join(root, "artifacts"), file));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed verification removes a stale successful seal before examining incomplete artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "posix-seal-stale-"));
  try {
    await writeFile(join(root, "verified-candidate.json"), '{"status":"verified-candidate"}');
    await assert.rejects(() => verifyPublicPosixCandidate(root), /ENOENT/u);
    await assert.rejects(() => readFile(join(root, "verified-candidate.json")), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("common-license originals retain internal publisher aliases and reject escaped or broken symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "posix-seal-common-licenses-"));
  const directory = join(root, "common-licenses");
  try {
    await mkdir(directory);
    const original = Buffer.from("Original GPL-3 publisher text\r\n");
    await writeFile(join(directory, "GPL-3"), original);
    await symlink("GPL-3", join(directory, "GPL"));
    const files = await readPosixCommonLicenseOriginals(directory);
    assert.deepEqual([...files.keys()], ["GPL", "GPL-3"]);
    assert.deepEqual(files.get("GPL"), original);
    assert.deepEqual(files.get("GPL-3"), original);
    await writeFile(join(root, "outside-license"), "Outside file");
    await symlink("../outside-license", join(directory, "escaped"));
    await assert.rejects(() => readPosixCommonLicenseOriginals(directory), /escapes/u);
    await rm(join(directory, "escaped"));
    await symlink("missing-license", join(directory, "broken"));
    await assert.rejects(() => readPosixCommonLicenseOriginals(directory), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline Cargo graph uses the verified compiler and excludes inherited wrappers without mutating caller", () => {
  const inherited = {
    PATH: "/runner/default/bin",
    RUSTC: "/runner/default/rustc",
    RUSTC_WRAPPER: "/user/wrapper",
    RUSTC_WORKSPACE_WRAPPER: "/user/workspace-wrapper",
    CARGO_HOME: "/user/cargo",
    KEEP: "unchanged",
  };
  const original = { ...inherited };
  const env = createPosixSealMetadataEnv("/verified/rust", "/verified/work", inherited);
  assert.equal(env.RUSTC, "/verified/rust/bin/rustc");
  assert.equal(env.PATH, "/verified/rust/bin:/runner/default/bin");
  assert.equal(env.CARGO_HOME, "/verified/work/cargo-home");
  assert.equal(env.CARGO_TARGET_DIR, "/verified/work/target");
  assert.equal(env.GIT_CEILING_DIRECTORIES, "/verified/work");
  assert.equal(Object.hasOwn(env, "RUSTC_WRAPPER"), false);
  assert.equal(Object.hasOwn(env, "RUSTC_WORKSPACE_WRAPPER"), false);
  assert.equal(env.KEEP, "unchanged");
  assert.deepEqual(inherited, original);
});
