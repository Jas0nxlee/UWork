import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDeterministicPosixArchive } from "../build-public-posix-ripgrep.mjs";
import {
  bindInstalledPosixRustComponents,
  collectPosixRipgrepMaterials,
} from "../public-posix-ripgrep-materials.mjs";
import {
  PUBLIC_POSIX_RIPGREP_PINS as pins,
  createPublicPosixRipgrepPlan,
  assertPosixCompilerIdentity,
  readPosixRustComponents,
  assertPosixPlatformReports,
} from "../public-posix-ripgrep-plan.mjs";

test("all four POSIX candidates retain native execution, original profile, static runtime and target JIT", () => {
  for (const platform of ["darwin", "linux"])
    for (const arch of ["x64", "arm64"]) {
      const p = createPublicPosixRipgrepPlan({
        platform,
        arch,
        hostPlatform: platform,
        hostArch: arch,
        env: {},
      });
      assert.equal(p.toolchain, "1.88.0");
      assert.equal(p.jit, arch === "x64");
      assert.deepEqual(p.profile, {
        debug: "0",
        strip: "true",
        lto: "true",
        codegenUnits: "1",
        panic: "unwind",
      });
      assert.ok(p.buildArgs.includes("--locked"));
      assert.ok(p.testArgs.includes("--all"));
      assert.equal(
        p.buildArgs.some((a) => a.startsWith("-Z")),
        false,
      );
      assert.equal(p.macosDeploymentTarget, platform === "darwin" ? "12.0" : null);
      assert.equal(p.jemallocPage, platform === "linux" && arch === "arm64" ? "16" : null);
      assert.throws(
        () =>
          createPublicPosixRipgrepPlan({
            platform,
            arch,
            hostPlatform: platform,
            hostArch: arch === "x64" ? "arm64" : "x64",
          }),
        /native/u,
      );
    }
  assert.throws(() => createPublicPosixRipgrepPlan({ platform: "win32", arch: "x64" }), /POSIX/u);
  assert.throws(
    () =>
      createPublicPosixRipgrepPlan({
        platform: "darwin",
        arch: "arm64",
        env: { RUSTC_BOOTSTRAP: "1" },
      }),
    /BOOTSTRAP/u,
  );
});

test("stable compiler identity is tied to the same public revision already used by POSIX binaries", () => {
  const text = `release: 1.88.0\ncommit-hash: ${pins.rustCommit}\nhost: aarch64-apple-darwin\n`;
  assert.doesNotThrow(() => assertPosixCompilerIdentity(text, "aarch64-apple-darwin"));
  for (const changed of [
    text.replace(pins.rustCommit, "0".repeat(40)),
    text.replace("1.88.0", "1.89.0"),
  ])
    assert.throws(() => assertPosixCompilerIdentity(changed, "aarch64-apple-darwin"), /Rust/u);
  assert.throws(() => assertPosixCompilerIdentity(text, "x86_64-apple-darwin"), /host/u);
});

test("manifest selects host compiler/std plus target musl std and matching source with official origins", () => {
  const p = createPublicPosixRipgrepPlan({
    platform: "linux",
    arch: "arm64",
    hostPlatform: "linux",
    hostArch: "arm64",
  });
  const sections = [
    "rustc.target.aarch64-unknown-linux-gnu",
    "cargo.target.aarch64-unknown-linux-gnu",
    "rust-std.target.aarch64-unknown-linux-gnu",
    "rust-std.target.aarch64-unknown-linux-musl",
    'rust-src.target."*"',
  ];
  const manifest = sections
    .map(
      (s, i) =>
        `[pkg.${s}]\navailable = true\nxz_url = "https://static.rust-lang.org/dist/2025-06-26/component-${i}.tar.xz"\nxz_hash = "${String(i).repeat(64)}"\n`,
    )
    .join("\n");
  const components = readPosixRustComponents(manifest, p);
  assert.equal(components.length, 5);
  assert.ok(components.some((c) => c.component.includes("linux-musl")));
  assert.throws(
    () => readPosixRustComponents(manifest.replace("static.rust-lang.org", "other.invalid"), p),
    /component/u,
  );
  assert.throws(
    () => readPosixRustComponents(manifest.replace("available = true", "available = false"), p),
    /component/u,
  );
});

test("platform verification rejects wrong architecture, newer macOS minimum and Linux dynamic linkage", () => {
  const mach = Buffer.alloc(32);
  mach.writeUInt32LE(0xfeedfacf);
  mach.writeUInt32LE(0x100000c, 4);
  mach.writeUInt32LE(2, 12);
  const mac = createPublicPosixRipgrepPlan({
    platform: "darwin",
    arch: "arm64",
    hostPlatform: "darwin",
    hostArch: "arm64",
  });
  const report = {
    loadCommands: "minos 12.0\n",
    dependencies: "rg:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n",
  };
  assert.doesNotThrow(() => assertPosixPlatformReports(mac, mach, report));
  assert.throws(() =>
    assertPosixPlatformReports(mac, mach, { ...report, loadCommands: "minos 13.0\n" }),
  );
  assert.throws(() =>
    assertPosixPlatformReports(mac, mach, {
      ...report,
      dependencies: report.dependencies + " /opt/local/libpcre2.dylib\n",
    }),
  );
  const elf = Buffer.alloc(64);
  elf.write("\x7fELF", 0, "binary");
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(0x3e, 18);
  const linux = createPublicPosixRipgrepPlan({
    platform: "linux",
    arch: "x64",
    hostPlatform: "linux",
    hostArch: "x64",
  });
  const staticReport = {
    programHeaders: "ELF file type is EXEC\n",
    dynamic: "There is no dynamic section in this file.\n",
    versions: "No version information found in this file.\n",
  };
  assert.doesNotThrow(() => assertPosixPlatformReports(linux, elf, staticReport));
  for (const change of [
    { programHeaders: "INTERP" },
    { dynamic: "(NEEDED) libc.so.6" },
    { versions: "GLIBC_2.28" },
  ])
    assert.throws(() => assertPosixPlatformReports(linux, elf, { ...staticReport, ...change }));
});

test("POSIX candidate archive preserves executable mode with one deterministic rg member", async () => {
  const binary = Buffer.from("ordinary candidate fixture");
  const archive = await createDeterministicPosixArchive(binary);
  assert.deepEqual(archive, await createDeterministicPosixArchive(binary));
  const tar = gunzipSync(archive);
  assert.equal(tar.subarray(0, 100).toString().split("\0")[0], "rg");
  assert.equal(tar.subarray(100, 107).toString(), "0000755");
  assert.deepEqual(tar.subarray(512, 512 + binary.length), binary);
});

async function ioFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "uwork-posix-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  return { root, put };
}

test("installed POSIX compiler, cargo and target std must byte-match official component payloads", async (t) => {
  const { root, put } = await ioFixture(t);
  const prefix = join(root, "installed");
  const plan = { target: "aarch64-apple-darwin" };
  const parts = [
    { name: "rustc", path: "bin/rustc" },
    { name: "cargo", path: "bin/cargo" },
    { name: "rust-std", path: `lib/rustlib/${plan.target}/lib/libstd-original.rlib` },
  ];
  for (const [index, part] of parts.entries()) {
    await put(join(root, `rust-component-${index}/components`), part.name + "\n");
    await put(
      join(root, `rust-component-${index}`, part.name, part.path),
      `original ${part.name}\n`,
    );
    await put(join(prefix, part.path), `original ${part.name}\n`);
  }
  const components = parts.map((p) => ({ component: p.name }));
  assert.equal((await bindInstalledPosixRustComponents(root, prefix, plan, components)).length, 3);
  await put(join(prefix, parts[2].path), "changed std runtime\n");
  await assert.rejects(
    bindInstalledPosixRustComponents(root, prefix, plan, components),
    /differs from the official component/u,
  );
});

async function materialFixture(t, brokenLink = false) {
  const { root, put } = await ioFixture(t);
  const sourceDir = join(root, "source"),
    artifacts = join(root, "artifacts"),
    prefix = join(root, "compiler");
  const document = join(prefix, "share/doc/rust");
  await put(
    join(document, "COPYRIGHT.html"),
    '<a href="licenses/License.txt">original license</a>',
  );
  await put(join(document, "COPYRIGHT-library.html"), "original library copyright\r\n");
  if (!brokenLink) await put(join(document, "licenses/License.txt"), "original linked license\r\n");
  const id = "path+ripgrep@14.1.1";
  await put(join(sourceDir, "Cargo.toml"), '[package]\nname="ripgrep"\nversion="14.1.1"\n');
  await put(join(sourceDir, "COPYING"), "original rg license\r\n");
  const lock = '[[package]]\nname = "ripgrep"\nversion = "14.1.1"\n';
  await put(join(sourceDir, "Cargo.lock"), lock);
  for (const file of [
    "Cargo.lock",
    "cargo-metadata.json",
    "cargo-build-messages.jsonl",
    "rustc-vv.txt",
    "pcre2-source-evidence.json",
    "microsoft-producer-LICENSE",
  ])
    await put(join(artifacts, file), file === "Cargo.lock" ? lock : "ordinary input fixture\n");
  return {
    sourceDir,
    cargoHome: join(root, "cargo"),
    prefix,
    artifacts,
    plan: { platform: "darwin", target: "aarch64-apple-darwin" },
    metadata: {
      packages: [
        {
          id,
          name: "ripgrep",
          version: "14.1.1",
          source: null,
          manifest_path: join(sourceDir, "Cargo.toml"),
        },
      ],
      resolve: { root: id, nodes: [{ id, deps: [] }] },
    },
    buildMessages: [{ reason: "compiler-artifact", package_id: id }],
  };
}

test("POSIX material collection retains original copyright and linked raw license bytes", async (t) => {
  const options = await materialFixture(t);
  const materials = await collectPosixRipgrepMaterials(options);
  assert.ok(
    materials.rustDistribution.some((r) => r.file === "rust/distribution/COPYRIGHT-library.html"),
  );
  assert.deepEqual(
    await readFile(join(options.artifacts, "materials/rust/distribution/licenses/License.txt")),
    Buffer.from("original linked license\r\n"),
  );
  assert.equal(materials.rustSource.length, 3);
  assert.ok(materials.packages[0].notices.length > 0);
});

test("a missing original Rust linked license blocks POSIX material collection", async (t) => {
  await assert.rejects(collectPosixRipgrepMaterials(await materialFixture(t, true)), /ENOENT/u);
});
