import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as sourcePins,
  assertSha256,
  sha256,
  stripPrivateCargoRegistry,
} from "./public-windows-ripgrep-plan.mjs";
import {
  PUBLIC_POSIX_RIPGREP_PINS as pins,
  readPosixRustComponents,
  assertPosixCompilerIdentity,
} from "./public-posix-ripgrep-plan.mjs";
import {
  PCRE2_SOURCE_PINS as pcrePins,
  execute,
  patchPcre2CargoInputs,
  preparePcre2Crate,
  applyPublicRipgrepPatch,
} from "./public-windows-ripgrep-source.mjs";
import { collectGraph } from "./collect-windows-ripgrep-license-materials.mjs";
import {
  originalPackageNotices,
  regularFiles,
  checkedPath,
} from "./windows-ripgrep-license-files.mjs";
import { parseCargoLock } from "./windows-ripgrep-license-archive.mjs";

export async function checkedCandidateFile(root, file) {
  assert.ok(
    typeof file === "string" && file.length > 0 && !isAbsolute(file),
    "Candidate path must be relative",
  );
  assert.ok(!file.split(/[\\/]/u).includes(".."), "Candidate path traversal");
  return checkedPath(root, resolve(root, file));
}

export function createPosixSealMetadataEnv(prefix, workRoot, inherited = process.env) {
  // 绝对 Cargo 路径仍会寻找环境里的 rustc；复算必须绑定刚核验的同一编译器并排除外部 wrapper。
  const env = {
    ...inherited,
    RUSTC: join(prefix, "bin/rustc"),
    PATH: `${join(prefix, "bin")}:${inherited.PATH ?? ""}`,
    CARGO_HOME: join(workRoot, "cargo-home"),
    CARGO_TARGET_DIR: join(workRoot, "target"),
    GIT_CEILING_DIRECTORIES: workRoot,
  };
  delete env.RUSTC_WRAPPER;
  delete env.RUSTC_WORKSPACE_WRAPPER;
  return env;
}

export async function readPosixCommonLicenseOriginals(root) {
  // Ubuntu 用目录内符号链接保留 GPL/LGPL 等发布方别名；逐项核验真实路径，不能遗漏别名或接受越界原文。
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  return new Map(
    await Promise.all(
      files.map(async (file) => [file, await readFile(await checkedPath(root, join(root, file)))]),
    ),
  );
}

export async function verifyPreparedSources(output, build, source, temporary) {
  const expected = join(temporary, "expected-source"),
    release = join(temporary, "pcre2-release");
  await mkdir(expected);
  await mkdir(release);
  for (const [file, hash] of Object.entries({
    "ripgrep-source.tar.gz": sourcePins.sourceSha256,
    "microsoft-binskim.patch": sourcePins.patchSha256,
    "pcre2-10.49.tar.gz": pcrePins.archiveSha256,
    "pcre2-sys-0.2.9.crate": pcrePins.crateSha256,
  }))
    assertSha256(await readFile(await checkedCandidateFile(output, file)), hash, file);
  await execute(
    "tar",
    ["-xzf", join(output, "ripgrep-source.tar.gz"), "-C", expected, "--strip-components=1"],
    { capture: true },
  );
  await applyPublicRipgrepPatch(expected, join(output, "microsoft-binskim.patch"));
  const config = join(expected, ".cargo/config.toml");
  await writeFile(config, stripPrivateCargoRegistry(await readFile(config, "utf8")));
  const patched = patchPcre2CargoInputs(
    await readFile(join(expected, "Cargo.toml"), "utf8"),
    await readFile(join(expected, "Cargo.lock"), "utf8"),
  );
  await writeFile(join(expected, "Cargo.toml"), patched.manifest);
  await writeFile(join(expected, "Cargo.lock"), patched.lock);
  const crate = join(expected, "vendor/pcre2-sys");
  await mkdir(crate, { recursive: true });
  await execute(
    "tar",
    ["-xzf", join(output, "pcre2-sys-0.2.9.crate"), "-C", crate, "--strip-components=1"],
    { capture: true },
  );
  await execute(
    "tar",
    ["-xzf", join(output, "pcre2-10.49.tar.gz"), "-C", release, "--strip-components=1"],
    { capture: true },
  );
  const prepared = await preparePcre2Crate(crate, release);
  for (const key of ["rustFiles", "licenses", "preparedFiles"])
    assert.deepEqual(
      source[key],
      prepared[key],
      `Prepared PCRE2 ${key} differs from official archive recipe`,
    );
  const actualRoot = await realpath(build.source.sourceDir);
  const expectedFiles = (await regularFiles(expected)).sort();
  assert.deepEqual(
    (await regularFiles(actualRoot)).sort(),
    expectedFiles,
    "Actual prepared source file inventory differs",
  );
  for (const file of expectedFiles)
    assert.deepEqual(
      await readFile(await checkedPath(actualRoot, join(actualRoot, file))),
      await readFile(join(expected, file)),
      `Actual build source drift: ${file}`,
    );
  return actualRoot;
}

export async function verifyRustComponents(output, build, plan, temporary) {
  const manifest = await readFile(await checkedCandidateFile(output, "rust-channel-manifest.toml"));
  assertSha256(manifest, pins.manifestSha256, "Official Rust channel manifest");
  const expectedComponents = readPosixRustComponents(manifest.toString("utf8"), plan);
  assert.deepEqual(
    build.toolchain.components.map(({ component, url, sha256: hash }) => ({
      component,
      url,
      sha256: hash,
    })),
    expectedComponents,
  );
  const originalNotices = new Map();
  const installedFiles = [];
  for (const [index, component] of build.toolchain.components.entries()) {
    assert.equal(component.file, `rust-components/${basename(new URL(component.url).pathname)}`);
    const archive = await checkedCandidateFile(output, component.file);
    assertSha256(await readFile(archive), component.sha256, component.component);
    const directory = join(temporary, `rust-component-${index}`);
    await mkdir(directory);
    await execute("tar", ["-xJf", archive, "-C", directory, "--strip-components=1"], {
      capture: true,
    });
    for (const file of await regularFiles(directory)) {
      const parts = file.split("/");
      const installRelative = parts.slice(1).join("/");
      const bytes = await readFile(join(directory, file));
      if (
        /^share\/doc\/rust\/(?:COPYRIGHT[^/]*\.html|LICENSE[^/]*|licenses\/)/u.test(installRelative)
      )
        originalNotices.set(installRelative.slice("share/doc/rust/".length), bytes);
      if (
        /^(?:bin|lib)\//u.test(installRelative) &&
        !installRelative.startsWith("lib/rustlib/src/")
      ) {
        assert.deepEqual(
          await readFile(
            await checkedPath(
              build.toolchain.prefix,
              join(build.toolchain.prefix, installRelative),
            ),
          ),
          bytes,
          `Installed Rust component drift: ${installRelative}`,
        );
        installedFiles.push({
          path: installRelative,
          component: component.component,
          sha256: sha256(bytes),
        });
      }
    }
  }
  assert.deepEqual(
    build.toolchain.installedFiles,
    installedFiles,
    "Actual installed compiler/std file closure differs from official component payloads",
  );
  assert.ok(installedFiles.some((f) => f.path === "bin/rustc"));
  assert.ok(installedFiles.some((f) => f.path === "bin/cargo"));
  assert.ok(
    installedFiles.some((f) => f.path.startsWith(`lib/rustlib/${plan.target}/lib/libstd-`)),
  );
  assert.equal(
    sha256(await readFile(join(build.toolchain.prefix, "bin/rustc"))),
    build.toolchain.compilerSha256,
  );
  assert.equal(
    sha256(await readFile(join(build.toolchain.prefix, "bin/cargo"))),
    build.toolchain.cargoSha256,
  );
  const identity = await execute(join(build.toolchain.prefix, "bin/rustc"), ["-vV"], {
    capture: true,
  });
  assert.deepEqual(assertPosixCompilerIdentity(identity, plan.host), build.toolchain.identity);
  assert.ok(originalNotices.has("COPYRIGHT.html") && originalNotices.has("COPYRIGHT-library.html"));
  return originalNotices;
}

export async function verifyMaterials(
  output,
  build,
  materials,
  metadata,
  sourceRoot,
  originalRustNotices,
) {
  const root = await realpath(join(output, "materials"));
  const verifyRecord = async (record) => {
    const bytes = await readFile(await checkedCandidateFile(root, record.file));
    assertSha256(bytes, record.sha256, `Original material ${record.file}`);
    assert.equal(bytes.length, record.bytes, `Original material length ${record.file}`);
    return bytes;
  };
  assert.deepEqual(
    materials.rustDistribution.map((r) => r.file.replace(/^rust\/distribution\//u, "")).sort(),
    [...originalRustNotices.keys()].sort(),
    "Original Rust distribution notice inventory mismatch",
  );
  for (const record of materials.rustDistribution)
    assert.deepEqual(
      await verifyRecord(record),
      originalRustNotices.get(record.file.slice("rust/distribution/".length)),
    );
  assert.equal(materials.rustSource.length, pins.sourceNotices.length);
  for (const [index, notice] of pins.sourceNotices.entries()) {
    const record = materials.rustSource[index];
    assert.equal(
      record.source,
      `https://raw.githubusercontent.com/rust-lang/rust/${pins.rustCommit}/${notice.path}`,
    );
    assert.equal(record.sha256, notice.sha256);
    await verifyRecord(record);
  }
  assertSha256(
    await verifyRecord(materials.patchLicense),
    sourcePins.patchLicenseSha256,
    "Microsoft original patch license",
  );
  const lock = parseCargoLock(await readFile(join(sourceRoot, "Cargo.lock"), "utf8"));
  const graph = collectGraph(metadata, new Set(["ripgrep"]));
  for (const record of materials.packages) {
    const pkg = graph.get(record.id);
    const expected = await originalPackageNotices(
      pkg,
      lock,
      {
        cargoHome: join(dirname(sourceRoot), "cargo-home"),
        allowedWorkspaceRoot: sourceRoot,
        workspaceLicense: metadata.packages.find((p) => p.name === "ripgrep").license,
      },
      [],
      async (file, bytes) => ({ file, sha256: sha256(bytes), bytes: bytes.length }),
    );
    assert.deepEqual(
      record.notices,
      expected.notices,
      `Cargo original notice inventory changed: ${pkg.id}`,
    );
    assert.equal(record.archiveSha256, expected.archiveSha256);
    for (const notice of record.notices) await verifyRecord(notice);
  }
  if (build.plan.platform === "linux") {
    assert.ok(materials.nativePackages.some((p) => p.name === "musl"));
    assert.ok(materials.nativePackages.some((p) => /^gcc(?:-|$)/u.test(p.name)));
    const installed = await execute(
      "dpkg-query",
      ["-W", "-f=${binary:Package}\t${Version}\t${db:Status-Status}\n"],
      { capture: true },
    );
    const selected = installed
      .trim()
      .split("\n")
      .flatMap((line) => {
        const [name, version, status] = line.split("\t");
        return status === "installed" &&
          /^(?:musl(?:-|:|$)|gcc(?:-\d+(?:-base)?|:|$)|libgcc-|binutils(?:-|:|$)|lld(?:-\d+|:|$))/u.test(
            name,
          )
          ? [{ name, version }]
          : [];
      });
    assert.deepEqual(
      materials.nativePackages.map(({ name, version }) => ({ name, version })),
      selected,
    );
    for (const record of materials.nativePackages)
      assert.deepEqual(
        await verifyRecord(record),
        await readFile(`/usr/share/doc/${record.name.split(":")[0]}/copyright`),
      );
    const originals = await readPosixCommonLicenseOriginals("/usr/share/common-licenses");
    assert.deepEqual(
      materials.nativeCommonLicenses
        .map((r) => r.file.slice("native/common-licenses/".length))
        .sort(),
      [...originals.keys()],
    );
    for (const record of materials.nativeCommonLicenses)
      assert.deepEqual(
        await verifyRecord(record),
        originals.get(record.file.slice("native/common-licenses/".length)),
      );
  } else {
    assert.deepEqual(materials.nativePackages, []);
    assert.deepEqual(materials.nativeCommonLicenses, []);
  }
}

export function assertPosixCargoGraph(metadata, messages, materials, target) {
  const graph = collectGraph(metadata, new Set(["ripgrep"]));
  const records = new Map(materials.packages.map((pkg) => [pkg.id, pkg]));
  assert.equal(records.size, materials.packages.length, "Duplicate Cargo license record");
  assert.deepEqual(
    [...records.keys()].sort(),
    [...graph.keys()].sort(),
    "Cargo material graph coverage mismatch",
  );
  for (const pkg of graph.values()) {
    const record = records.get(pkg.id);
    assert.equal(record.name, pkg.name);
    assert.equal(record.version, pkg.version);
    assert.ok(record.notices?.length > 0, `Missing original Cargo notices: ${pkg.id}`);
    if (pkg.source) assert.match(record.archiveSha256, /^[a-f0-9]{64}$/u);
  }
  const artifacts = messages.filter((entry) => entry.reason === "compiler-artifact");
  for (const entry of artifacts)
    assert.ok(graph.has(entry.package_id), "Actual compiler artifact outside Cargo graph");
  assert.equal(messages.at(-1)?.reason, "build-finished");
  assert.equal(messages.at(-1)?.success, true, "Actual Cargo build did not finish successfully");
  const sys = [...graph.values()].find((pkg) => pkg.name === "pcre2-sys");
  assert.ok(sys && !sys.source, "PCRE2 must use verified prepared source");
  assert.equal(sys.version, pcrePins.crateVersion);
  assert.ok(
    artifacts.some(
      (a) => a.package_id === sys.id && a.target.name === "pcre2_sys" && a.fresh === false,
    ),
    "PCRE2 crate must be freshly built",
  );
  assert.ok(
    artifacts.some(
      (a) => a.package_id === sys.id && a.target.kind.includes("custom-build") && a.fresh === false,
    ),
    "PCRE2 build script must be freshly built",
  );
  const links = messages.filter(
    (entry) => entry.reason === "build-script-executed" && entry.package_id === sys.id,
  );
  assert.equal(links.length, 1, "Expected one actual PCRE2 native link record");
  // 原始 build.rs compile("libpcre2.a") 与固定 cc 1.1.18 会发出 static=pcre2，系统库名不同。
  assert.ok(links[0].linked_libs.includes("static=pcre2"), "Expected static prepared PCRE2 link");
  const binaries = artifacts.filter(
    (a) =>
      graph.get(a.package_id).name === "ripgrep" &&
      a.target.name === "rg" &&
      a.target.kind.includes("bin"),
  );
  assert.equal(binaries.length, 1, "Expected one actual rg compiler artifact");
  const binary = binaries[0];
  assert.equal(binary.fresh, false, "Candidate binary must be freshly built");
  assert.ok(binary.executable && binary.filenames.includes(binary.executable));
  assert.ok(
    binary.executable.split(/[\\/]/u).includes(target),
    "Cargo binary target path mismatch",
  );
  return { executable: binary.executable, graph, pcre2Link: links[0] };
}
