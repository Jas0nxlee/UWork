import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as pins,
  assertSha256,
  sha256,
  stripPrivateCargoRegistry,
} from "./public-windows-ripgrep-plan.mjs";

export const PCRE2_SOURCE_PINS = Object.freeze({
  version: "10.49",
  releaseUrl: "https://github.com/PCRE2Project/pcre2/releases/tag/pcre2-10.49",
  releaseApiUrl: "https://api.github.com/repos/PCRE2Project/pcre2/releases/tags/pcre2-10.49",
  archiveUrl:
    "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.49/pcre2-10.49.tar.gz",
  archiveSha256: "929f0b20e62879252a15886b06c89f1edef61a363cbd5826fb041080a5e557ae",
  crateVersion: "0.2.9",
  crateUrl: "https://static.crates.io/crates/pcre2-sys/pcre2-sys-0.2.9.crate",
  crateSha256: "550f5d18fb1b90c20b87e161852c10cde77858c3900c5059b5ad2a1449f11d8a",
});

// 10.49 官方 NON-AUTOTOOLS-BUILD 的库清单；build.rs 扫描 .c，不能混入测试/CLI。
export const PCRE2_LIBRARY_SOURCES = Object.freeze([
  "pcre2_auto_possess.c",
  "pcre2_chkdint.c",
  "pcre2_compile.c",
  "pcre2_compile_cgroup.c",
  "pcre2_compile_class.c",
  "pcre2_config.c",
  "pcre2_context.c",
  "pcre2_convert.c",
  "pcre2_dfa_match.c",
  "pcre2_error.c",
  "pcre2_extuni.c",
  "pcre2_find_bracket.c",
  "pcre2_jit_compile.c",
  "pcre2_maketables.c",
  "pcre2_match.c",
  "pcre2_match_data.c",
  "pcre2_match_next.c",
  "pcre2_newline.c",
  "pcre2_ord2utf.c",
  "pcre2_pattern_info.c",
  "pcre2_script_run.c",
  "pcre2_serialize.c",
  "pcre2_string_utils.c",
  "pcre2_study.c",
  "pcre2_substitute.c",
  "pcre2_substring.c",
  "pcre2_tables.c",
  "pcre2_ucd.c",
  "pcre2_valid_utf.c",
  "pcre2_xclass.c",
]);

export function patchPcre2CargoInputs(manifest, lock) {
  if (/^\[patch\./mu.test(manifest)) throw new Error("Existing Cargo patch section is unsupported");
  const sections = lock.split(/(?=^\[\[package\]\])/mu);
  const matches = sections.filter((section) => /^name = "pcre2-sys"$/mu.test(section));
  const entry = matches[0] ?? "";
  const source = 'source = "registry+https://github.com/rust-lang/crates.io-index"\n';
  const checksum = `checksum = "${PCRE2_SOURCE_PINS.crateSha256}"\n`;
  if (
    matches.length !== 1 ||
    !/^version = "0\.2\.9"$/mu.test(entry) ||
    !entry.includes(source) ||
    !entry.includes(checksum)
  )
    throw new Error("Expected exactly the original locked pcre2-sys 0.2.9 identity and checksum");
  return {
    manifest: manifest + '\n[patch.crates-io]\npcre2-sys = { path = "vendor/pcre2-sys" }\n',
    lock: sections
      .map((section) =>
        section === entry ? entry.replace(source, "").replace(checksum, "") : section,
      )
      .join(""),
  };
}

async function fileHashes(root, directory = root) {
  const records = {};
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(records, await fileHashes(root, path));
    else if (entry.isFile())
      records[relative(root, path).split(sep).join("/")] = sha256(await readFile(path));
    else throw new Error(`Unexpected non-regular prepared source: ${entry.name}`);
  }
  return records;
}

export async function preparePcre2Crate(crateDir, releaseDir) {
  const header = await readFile(join(releaseDir, "src/pcre2.h.generic"), "utf8");
  if (!/^#define PCRE2_MAJOR\s+10$/mu.test(header) || !/^#define PCRE2_MINOR\s+49$/mu.test(header))
    throw new Error("Expected official PCRE2 10.49 header");
  const rustFiles = Object.fromEntries(
    await Promise.all(
      ["build.rs", "src/bindings.rs", "Cargo.toml", "COPYING", "LICENSE-MIT"].map(async (path) => [
        path,
        sha256(await readFile(join(crateDir, path))),
      ]),
    ),
  );
  const upstream = join(crateDir, "upstream");
  // 仅在已验 SHA 的临时 crate 内替换旧 C 源码；保留原 build.rs 的 JIT/静态策略。
  await rm(upstream, { recursive: true, force: true });
  await mkdir(join(upstream, "src"), { recursive: true });
  await mkdir(join(upstream, "include"));
  const headers = (await readdir(join(releaseDir, "src"))).filter((name) => name.endsWith(".h"));
  for (const name of [...PCRE2_LIBRARY_SOURCES, ...headers])
    await copyFile(join(releaseDir, "src", name), join(upstream, "src", name));
  for (const [from, to] of [
    ["config.h.generic", "include/config.h"],
    ["pcre2.h.generic", "include/pcre2.h"],
    ["pcre2_chartables.c.dist", "src/pcre2_chartables.c"],
  ])
    await copyFile(join(releaseDir, "src", from), join(upstream, to));
  await mkdir(join(upstream, "deps/sljit"), { recursive: true });
  await cp(join(releaseDir, "deps/sljit/sljit_src"), join(upstream, "deps/sljit/sljit_src"), {
    recursive: true,
  });
  const licenses = {};
  for (const path of ["COPYING", "LICENCE.md", "deps/sljit/LICENSE"]) {
    await copyFile(join(releaseDir, path), join(upstream, path));
    licenses[path] = sha256(await readFile(join(upstream, path)));
  }
  const preparedFiles = await fileHashes(crateDir);
  for (const [path, hash] of Object.entries(rustFiles))
    if (preparedFiles[path] !== hash) throw new Error(`Original Rust crate file changed: ${path}`);
  return { rustFiles, licenses, preparedFiles };
}

export async function prepareVendoredPcre2Sources(sourceDir, workDir, artifactsDir) {
  const originalManifest = await readFile(join(sourceDir, "Cargo.toml"), "utf8");
  const originalLock = await readFile(join(sourceDir, "Cargo.lock"), "utf8");
  const patched = patchPcre2CargoInputs(originalManifest, originalLock);
  const crateDir = join(sourceDir, "vendor/pcre2-sys");
  await mkdir(join(sourceDir, "vendor"), { recursive: true });
  await mkdir(crateDir); // Existing preparation is rejected instead of overwritten.
  const releaseDir = join(workDir, "pcre2-10.49");
  await mkdir(releaseDir);
  const pcre = PCRE2_SOURCE_PINS;
  const [crate, release] = await Promise.all([
    fetchPinnedBytes(pcre.crateUrl, pcre.crateSha256, "original pcre2-sys crate"),
    fetchPinnedBytes(pcre.archiveUrl, pcre.archiveSha256, "official PCRE2 release"),
  ]);
  const crateArchive = join(artifactsDir, "pcre2-sys-0.2.9.crate");
  const releaseArchive = join(artifactsDir, "pcre2-10.49.tar.gz");
  await writeFile(crateArchive, crate);
  await writeFile(releaseArchive, release);
  await execute("tar", ["-xzf", crateArchive, "-C", crateDir, "--strip-components=1"]);
  await execute("tar", ["-xzf", releaseArchive, "-C", releaseDir, "--strip-components=1"]);
  const prepared = await preparePcre2Crate(crateDir, releaseDir);
  await writeFile(join(artifactsDir, "original-ripgrep-Cargo.lock"), originalLock);
  await writeFile(join(sourceDir, "Cargo.toml"), patched.manifest);
  await writeFile(join(sourceDir, "Cargo.lock"), patched.lock);
  const licenseEvidence = {};
  for (const [path, hash] of Object.entries(prepared.licenses)) {
    const file = `pcre2-10.49-${path.replaceAll("/", "-")}`;
    await copyFile(join(crateDir, "upstream", path), join(artifactsDir, file));
    licenseEvidence[path] = { file, sha256: hash };
  }
  const evidence = {
    schemaVersion: 1,
    status: "source-prepared-only",
    ...pcre,
    signatureVerification: "not-performed",
    cratePath: "vendor/pcre2-sys",
    releaseDir,
    archives: {
      crate: { file: "pcre2-sys-0.2.9.crate", sha256: pcre.crateSha256 },
      pcre2: { file: "pcre2-10.49.tar.gz", sha256: pcre.archiveSha256 },
    },
    cargo: {
      originalManifestSha256: sha256(originalManifest),
      manifestSha256: sha256(patched.manifest),
      originalLockSha256: sha256(originalLock),
      lockSha256: sha256(patched.lock),
    },
    ...prepared,
    licenseEvidence,
  };
  await writeFile(
    join(artifactsDir, "pcre2-source-evidence.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  return evidence;
}

export async function execute(
  command,
  args,
  { cwd, env = process.env, logPath, capture = false } = {},
) {
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  const errors = [];
  child.stdout.on("data", (data) => {
    output.push(data);
    if (!capture) process.stdout.write(data);
  });
  child.stderr.on("data", (data) => {
    errors.push(data);
    process.stderr.write(data);
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const stdout = Buffer.concat(output).toString("utf8");
  const stderr = Buffer.concat(errors).toString("utf8");
  if (logPath) await writeFile(logPath, stdout + stderr);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  return stdout;
}

export async function fetchPinnedBytes(url, expected, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${label} download returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assertSha256(bytes, expected, label);
  return bytes;
}

export async function applyPublicRipgrepPatch(sourceDir, patchPath, inheritedEnv = process.env) {
  // source archive has no .git; stop git from attributing the enclosing verification branch to rg.
  const env = { ...inheritedEnv, GIT_CEILING_DIRECTORIES: dirname(sourceDir) };
  // Windows runner 的 autocrlf 会改写已核验的 Cargo.lock；仅对本次 apply 固定 LF，保留其他字节。
  const args = ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "apply"];
  await execute("git", [...args, "--check", patchPath], { cwd: sourceDir, env });
  await execute("git", [...args, patchPath], { cwd: sourceDir, env });
}

export async function preparePublicRipgrepSources(
  workDir,
  artifactsDir,
  rustManifestPins = {
    url: pins.rustManifestUrl,
    sha256: pins.rustManifestSha256,
  },
) {
  await mkdir(workDir, { recursive: false });
  await mkdir(artifactsDir, { recursive: true });
  const sourceDir = join(workDir, "source");
  await mkdir(sourceDir);
  const [source, patch, manifest, patchLicense] = await Promise.all([
    fetchPinnedBytes(pins.sourceUrl, pins.sourceSha256, "ripgrep source"),
    fetchPinnedBytes(pins.patchUrl, pins.patchSha256, "Microsoft patch"),
    fetchPinnedBytes(rustManifestPins.url, rustManifestPins.sha256, "Rust manifest"),
    fetchPinnedBytes(pins.patchLicenseUrl, pins.patchLicenseSha256, "Microsoft patch license"),
  ]);
  const sourceArchive = join(workDir, "ripgrep-source.tar.gz");
  const patchPath = join(artifactsDir, "microsoft-binskim.patch");
  await Promise.all([
    writeFile(sourceArchive, source),
    writeFile(patchPath, patch),
    writeFile(join(artifactsDir, "rust-channel-manifest.toml"), manifest),
    writeFile(join(artifactsDir, "microsoft-producer-LICENSE"), patchLicense),
  ]);
  await execute("tar", ["-xzf", sourceArchive, "-C", sourceDir, "--strip-components=1"]);
  await applyPublicRipgrepPatch(sourceDir, patchPath);
  const configPath = join(sourceDir, ".cargo", "config.toml");
  await writeFile(configPath, stripPrivateCargoRegistry(await readFile(configPath, "utf8")));
  const pcre2 = await prepareVendoredPcre2Sources(sourceDir, workDir, artifactsDir);
  const lock = await readFile(join(sourceDir, "Cargo.lock"));
  await writeFile(join(artifactsDir, "Cargo.lock"), lock);
  await writeFile(join(artifactsDir, "patched-cargo-config.toml"), await readFile(configPath));
  return { sourceDir, manifest: manifest.toString("utf8"), cargoLockSha256: sha256(lock), pcre2 };
}
