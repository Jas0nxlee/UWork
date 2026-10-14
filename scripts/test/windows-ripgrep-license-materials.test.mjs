import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  collectWindowsRipgrepLicenseMaterials,
  readCrateArchive,
  RUST_PIN,
} from "../collect-windows-ripgrep-license-materials.mjs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const target = "x86_64-pc-windows-msvc";
function tar(members) {
  const buffers = [];
  for (const [name, value] of Object.entries(members)) {
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
    );
    buffers.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "uwork-rg-materials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    sourceDir: join(root, "source"),
    cargoHome: join(root, "cargo"),
    rustupHome: join(root, "rustup"),
    outputDir: join(root, "output"),
    toolchain: RUST_PIN.channel,
    target,
    buildManifest: join(root, "artifacts/build-evidence.json"),
  };
  const put = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  const sysroot = join(options.rustupHome, "toolchains", `${options.toolchain}-${target}`);
  const rustSource = join(sysroot, "lib/rustlib/src/rust");
  const registrySource = "registry+https://github.com/rust-lang/crates.io-index";
  const dep = {
    id: "registry+dep@1.0.0",
    name: "dep",
    version: "1.0.0",
    source: registrySource,
    license: "MIT",
    manifest_path: join(options.cargoHome, "registry/src/index/dep-1.0.0/Cargo.toml"),
  };
  const app = {
    id: "path+ripgrep@14.1.1",
    name: "ripgrep",
    version: "14.1.1",
    source: null,
    license: "Unlicense OR MIT",
    manifest_path: join(options.sourceDir, "Cargo.toml"),
  };
  const archive = tar({
    "dep-1.0.0/LICENSE-MIT": "Original publisher fixture bytes\n",
    "dep-1.0.0/Cargo.toml": "[package]\nname='dep'\n",
  });
  const lock = `version = 4\n[[package]]\nname = "ripgrep"\nversion = "14.1.1"\n[[package]]\nname = "dep"\nversion = "1.0.0"\nsource = "${registrySource}"\nchecksum = "${sha(archive)}"\n`;
  const stdNames = ["core", "alloc", "std", "panic_unwind", "compiler_builtins"];
  const stdPackages = stdNames.map((name) => ({
    id: `path+${name}@0.0.0`,
    name,
    version: "0.0.0",
    source: null,
    license: "MIT OR Apache-2.0",
    manifest_path: join(rustSource, "library", name, "Cargo.toml"),
  }));
  const stdLock = stdPackages
    .map((pkg) => `[[package]]\nname = "${pkg.name}"\nversion = "${pkg.version}"\n`)
    .join("\n");
  const artifacts = [
    ...[app, dep, ...stdPackages].map((pkg) => ({
      reason: "compiler-artifact",
      package_id: pkg.id,
      target: { name: pkg.name },
      fresh: false,
    })),
    { reason: "build-finished", success: true },
  ];
  const build = {
    schemaVersion: 1,
    target,
    toolchain: { ...RUST_PIN, host: target },
    source: {
      revision: "4649aa9700619f94cf9c66876e9549d83420e16c",
      cargoLockSha256: sha(lock),
      patchSha256: "8cf3c2eeeb4261d66a838f7fe8a8e9870a6ce3a7f1c1d3a2a9d5e36b5a947cac",
      patchLicense: {
        file: "microsoft-producer-LICENSE",
        source:
          "https://raw.githubusercontent.com/microsoft/ripgrep-prebuilt/7ea8b7eb6c0de96fe4275bba5e88cb49297af42e/LICENSE",
        sha256: "dea9265341829002e2c23a7372393eb2ed6e26085fb623f38a4ba0af833f30a6",
      },
    },
    hardening: { panicStrategy: "unwind" },
  };
  const artifact = (name) => join(dirname(options.buildManifest), name);
  await put(options.buildManifest, JSON.stringify(build));
  await put(
    artifact("microsoft-producer-LICENSE"),
    await readFile(new URL("./fixtures/microsoft-ripgrep-producer-LICENSE.txt", import.meta.url)),
  );
  await put(join(options.sourceDir, "Cargo.lock"), lock);
  await put(join(options.sourceDir, "COPYING"), "Original repository fixture notice\n");
  await put(artifact("Cargo.lock"), lock);
  await put(artifact("std-Cargo.lock"), stdLock);
  await put(join(rustSource, "library/Cargo.lock"), stdLock);
  await put(app.manifest_path, "[package]\nname='ripgrep'\n");
  await put(dep.manifest_path, "[package]\nname='dep'\n");
  for (const pkg of stdPackages) await put(pkg.manifest_path, "[package]\n");
  await put(join(options.cargoHome, "registry/cache/index/dep-1.0.0.crate"), archive);
  await put(
    artifact("cargo-metadata.json"),
    JSON.stringify({
      packages: [app, dep],
      resolve: {
        nodes: [
          { id: app.id, deps: [{ pkg: dep.id, dep_kinds: [{ kind: null, target: null }] }] },
          { id: dep.id, deps: [] },
        ],
      },
    }),
  );
  await put(
    artifact("std-cargo-metadata.json"),
    JSON.stringify({
      packages: stdPackages,
      resolve: { nodes: stdPackages.map((pkg) => ({ id: pkg.id, deps: [] })) },
    }),
  );
  await put(
    artifact("cargo-build-messages.jsonl"),
    artifacts.map((item) => JSON.stringify(item)).join("\n"),
  );
  await put(
    artifact("rustc-vv.txt"),
    `rustc ${RUST_PIN.release}\nrelease: ${RUST_PIN.release}\ncommit-hash: ${RUST_PIN.commit}\nhost: ${target}\n`,
  );
  await put(
    artifact("rust-channel-manifest.toml"),
    await readFile(
      new URL("./fixtures/public-rust-nightly-2025-06-26.manifest.txt", import.meta.url),
    ),
  );
  const docs = join(sysroot, "share/doc/rust");
  await put(join(docs, "COPYRIGHT.html"), '<html><a href="licenses/MIT.txt">fixture</a></html>');
  await put(
    join(docs, "COPYRIGHT-library.html"),
    '<html>Standard library fixture<a href="licenses/MIT.txt">terms</a></html>',
  );
  await put(join(docs, "licenses/MIT.txt"), "Original Rust distribution fixture terms\n");
  return { options, artifact, put, docs, dep, app, build, lock, archive };
}

test("original checksum-bound crate bytes, rebuilt std artifacts and original Rust directory are retained", async (t) => {
  const f = await fixture(t);
  // 修改解压树不能冒充 archive 中的原许可。
  await f.put(join(dirname(f.dep.manifest_path), "LICENSE-MIT"), "mutated source tree license");
  const result = await collectWindowsRipgrepLicenseMaterials(f.options);
  assert.equal(result.packages.length, 7);
  const dep = result.packages.find((pkg) => pkg.name === "dep");
  assert.equal(
    await readFile(join(f.options.outputDir, dep.notices[0].file), "utf8"),
    "Original publisher fixture bytes\n",
  );
  assert.equal(result.rustNotices.length, 18);
  assert.equal(result.rustNoticeCollections.compilerBuildEvidence.length, 1);
  assert.ok(
    !result.rustNoticeCollections.standardLibraryAndConservativeLicenseCorpus.some(
      (notice) => notice.file === "rust/COPYRIGHT.html",
    ),
  );
  assert.equal(result.compilerArtifacts.length, 7);
  assert.equal(result.unprovedScope.length, 1);
  assert.equal(result.status, "incomplete-native-runtime");
  assert.match(result.scope, /build-only/u);
});

test("wrong compiler identity or publisher manifest fails before a completed inventory", async (t) => {
  const f = await fixture(t);
  await f.put(
    f.artifact("rustc-vv.txt"),
    "release: 1.88.0\ncommit-hash: private\nhost: x86_64-pc-windows-msvc\n",
  );
  await assert.rejects(collectWindowsRipgrepLicenseMaterials(f.options), /compiler release/u);
  await assert.rejects(readFile(join(f.options.outputDir, "materials.json")), { code: "ENOENT" });
});

test("missing rebuilt std or unaccounted compiler package cannot claim license closure", async (t) => {
  const f = await fixture(t);
  const messages = (await readFile(f.artifact("cargo-build-messages.jsonl"), "utf8"))
    .split("\n")
    .map(JSON.parse);
  await f.put(
    f.artifact("cargo-build-messages.jsonl"),
    messages
      .filter((item) => item.target?.name !== "panic_unwind")
      .map(JSON.stringify)
      .join("\n"),
  );
  await assert.rejects(
    collectWindowsRipgrepLicenseMaterials(f.options),
    /Missing rebuilt.*panic_unwind/u,
  );
  messages.push({
    reason: "compiler-artifact",
    package_id: "unaccounted",
    target: { name: "unknown" },
  });
  await f.put(f.artifact("cargo-build-messages.jsonl"), messages.map(JSON.stringify).join("\n"));
  await assert.rejects(
    collectWindowsRipgrepLicenseMaterials(f.options),
    /omitted from license graph/u,
  );
});

test("mutated cache, dangling license links and path traversal are rejected", async (t) => {
  const f = await fixture(t);
  const cache = join(f.options.cargoHome, "registry/cache/index/dep-1.0.0.crate");
  await f.put(cache, Buffer.from("corrupt"));
  await assert.rejects(collectWindowsRipgrepLicenseMaterials(f.options), /checksum mismatch/u);
  await f.put(cache, f.archive);
  await rm(join(f.docs, "licenses/MIT.txt"));
  await assert.rejects(collectWindowsRipgrepLicenseMaterials(f.options));
  const unsafe = tar({ "dep-1.0.0/../LICENSE": "unsafe" });
  await assert.rejects(readCrateArchive(unsafe, sha(unsafe)), /Unsafe crate member path/u);
});

test("arbitrary VS notice count cannot close native runtime applicability", async () => {
  const { nativeRuntimeBindingMatches } = await import("../windows-ripgrep-runtime-materials.mjs");
  const runtime = {
    visualStudioVersion: "17.14.1",
    vcToolsVersion: "14.44.1",
    windowsSdkVersion: "10.0.1",
  };
  const notices = [{ source: "unrelated VS notice", sha256: "a".repeat(64) }];
  assert.equal(nativeRuntimeBindingMatches(runtime, notices, [], []), false);
  assert.equal(nativeRuntimeBindingMatches(runtime, notices, [], [{ ...runtime }]), false);
});
