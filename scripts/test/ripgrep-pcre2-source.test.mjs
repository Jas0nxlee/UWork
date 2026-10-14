import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  PCRE2_SOURCE_PINS as pins,
  PCRE2_LIBRARY_SOURCES,
  patchPcre2CargoInputs,
  preparePcre2Crate,
  prepareVendoredPcre2Sources,
  fetchPinnedBytes,
  applyPublicRipgrepPatch,
} from "../public-windows-ripgrep-source.mjs";
import { sha256 } from "../public-windows-ripgrep-plan.mjs";

const packageEntry = `[[package]]\nname = "pcre2-sys"\nversion = "0.2.9"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${pins.crateSha256}"\ndependencies = ["cc", "libc", "pkg-config"]\n`;
const otherEntry = `[[package]]\nname = "cc"\nversion = "1.0.99"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${"1".repeat(64)}"\n`;
const manifest = '[package]\nname = "ripgrep"\nversion = "14.1.1"\n';
const lock = `version = 3\n\n${packageEntry}\n${otherEntry}`;

test("the pinned maintenance release retains every other Cargo checksum and dependency", () => {
  assert.equal(pins.version, "10.49");
  assert.equal(
    pins.archiveSha256,
    "929f0b20e62879252a15886b06c89f1edef61a363cbd5826fb041080a5e557ae",
  );
  const patched = patchPcre2CargoInputs(manifest, lock);
  assert.equal(
    patched.lock,
    lock.replace(
      'source = "registry+https://github.com/rust-lang/crates.io-index"\n' +
        `checksum = "${pins.crateSha256}"\n`,
      "",
    ),
  );
  assert.ok(patched.lock.includes(otherEntry));
  assert.equal(
    patched.manifest,
    manifest + '\n[patch.crates-io]\npcre2-sys = { path = "vendor/pcre2-sys" }\n',
  );
  for (const invalid of [
    lock.replace(pins.crateSha256, "0".repeat(64)),
    lock.replace('version = "0.2.9"', 'version = "0.2.10"'),
    lock + packageEntry,
    lock.replace('name = "pcre2-sys"', 'name = "other"'),
  ])
    assert.throws(() => patchPcre2CargoInputs(manifest, invalid), /pcre2-sys/u);
  assert.throws(() => patchPcre2CargoInputs(manifest + "\n[patch.crates-io]\n", lock), /patch/u);
});

test("archive digest mismatch fails before extraction", async () => {
  const bytes = "ordinary archive contract fixture";
  const url = `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
  assert.deepEqual(await fetchPinnedBytes(url, sha256(bytes), "fixture"), Buffer.from(bytes));
  await assert.rejects(fetchPinnedBytes(url, "0".repeat(64), "fixture"), /SHA-256 mismatch/u);
});

test("real Git patch application retains LF Cargo bytes under inherited Windows autocrlf settings", async (t) => {
  const { crateDir, put } = await fixture(t);
  await put(join(crateDir, "Cargo.toml"), manifest);
  await put(join(crateDir, "Cargo.lock"), lock);
  const patchPath = join(dirname(crateDir), "original.patch");
  const inserted = "# Original producer patch fixture\n";
  await put(
    patchPath,
    `diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n@@ -1,2 +1,3 @@\n version = 3\n+${inserted} \n`,
  );
  await applyPublicRipgrepPatch(crateDir, patchPath, {
    ...process.env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_KEY_1: "core.eol",
    GIT_CONFIG_VALUE_1: "crlf",
  });
  const actual = await readFile(join(crateDir, "Cargo.lock"), "utf8");
  assert.equal(actual, lock.replace("version = 3\n", "version = 3\n" + inserted));
  assert.doesNotMatch(actual, /\r/u);
  assert.doesNotThrow(() => patchPcre2CargoInputs(manifest, actual));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "uwork-pcre2-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const crateDir = join(root, "crate");
  const releaseDir = join(root, "release");
  const put = async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  };
  for (const [path, bytes] of Object.entries({
    "build.rs": "// original platform JIT and static policy fixture\n",
    "src/bindings.rs": "// original ABI fixture\n",
    "Cargo.toml": '[package]\nname = "pcre2-sys"\nversion = "0.2.9"\n',
    COPYING: "original crate notice\n",
    "LICENSE-MIT": "original MIT notice\n",
    "upstream/src/obsolete.c": "old fixture\n",
  }))
    await put(join(crateDir, path), bytes);
  for (const [path, bytes] of Object.entries({
    ...Object.fromEntries(PCRE2_LIBRARY_SOURCES.map((name) => [`src/${name}`, `/* ${name} */\n`])),
    "src/pcre2.h.generic": "#define PCRE2_MAJOR 10\n#define PCRE2_MINOR 49\n",
    "src/config.h.generic": "/* original default config */\n",
    "src/pcre2_chartables.c.dist": "/* original default chartable */\n",
    "src/pcre2_internal.h": "/* original private header */\n",
    "src/pcre2_jit_match_inc.h": "/* original JIT header */\n",
    "src/pcre2test.c": "/* tool fixture must not compile in the library */\n",
    "deps/sljit/sljit_src/sljitLir.c": "/* original sljit */\n",
    "deps/sljit/LICENSE": "original sljit license\r\n",
    "LICENCE.md": "original PCRE2 license\r\n",
    COPYING: "original PCRE2 copyright pointer\n",
  }))
    await put(join(releaseDir, path), bytes);
  return { crateDir, releaseDir, put };
}

test("prepared crate uses current library/sljit layout with original Rust and raw legal bytes", async (t) => {
  const { crateDir, releaseDir } = await fixture(t);
  const result = await preparePcre2Crate(crateDir, releaseDir);
  assert.equal(result.rustFiles["build.rs"], sha256(await readFile(join(crateDir, "build.rs"))));
  assert.equal(
    result.rustFiles["src/bindings.rs"],
    sha256(await readFile(join(crateDir, "src/bindings.rs"))),
  );
  const sources = (await readdir(join(crateDir, "upstream/src"))).filter((name) =>
    name.endsWith(".c"),
  );
  assert.deepEqual(sources.sort(), [...PCRE2_LIBRARY_SOURCES, "pcre2_chartables.c"].sort());
  for (const name of ["pcre2_compile_cgroup.c", "pcre2_compile_class.c", "pcre2_match_next.c"])
    assert.ok(sources.includes(name), `10.49 documented library member ${name} is required`);
  assert.equal(
    result.preparedFiles["upstream/deps/sljit/sljit_src/sljitLir.c"],
    sha256("/* original sljit */\n"),
  );
  for (const path of ["LICENCE.md", "COPYING", "deps/sljit/LICENSE"]) {
    assert.deepEqual(
      await readFile(join(crateDir, "upstream", path)),
      await readFile(join(releaseDir, path)),
    );
    assert.equal(result.licenses[path], result.preparedFiles[`upstream/${path}`]);
  }
  assert.equal(result.preparedFiles["upstream/src/obsolete.c"], undefined);
  assert.equal(result.preparedFiles["upstream/src/pcre2test.c"], undefined);
  for (const [path, hash] of Object.entries(result.preparedFiles))
    assert.equal(sha256(await readFile(join(crateDir, path))), hash);
});

test("source preparation rejects a changed version or absent documented library file", async (t) => {
  const { crateDir, releaseDir, put } = await fixture(t);
  await put(
    join(releaseDir, "src/pcre2.h.generic"),
    "#define PCRE2_MAJOR 10\n#define PCRE2_MINOR 48\n",
  );
  await assert.rejects(preparePcre2Crate(crateDir, releaseDir), /10.49/u);
  await put(
    join(releaseDir, "src/pcre2.h.generic"),
    "#define PCRE2_MAJOR 10\n#define PCRE2_MINOR 49\n",
  );
  await rm(join(releaseDir, "src/pcre2_compile_cgroup.c"));
  await assert.rejects(preparePcre2Crate(crateDir, releaseDir), /ENOENT/u);
});

test("repeat preparation rejects an existing path crate without downloading or rewriting inputs", async (t) => {
  const { crateDir, put } = await fixture(t);
  await put(join(crateDir, "Cargo.toml"), manifest);
  await put(join(crateDir, "Cargo.lock"), lock);
  await mkdir(join(crateDir, "vendor/pcre2-sys"), { recursive: true });
  await assert.rejects(prepareVendoredPcre2Sources(crateDir, "unused", "unused"), /EEXIST/u);
  assert.equal(await readFile(join(crateDir, "Cargo.toml"), "utf8"), manifest);
  assert.equal(await readFile(join(crateDir, "Cargo.lock"), "utf8"), lock);
});
