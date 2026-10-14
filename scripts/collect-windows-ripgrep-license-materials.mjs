import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { PUBLIC_WINDOWS_RIPGREP_PINS as sourcePins } from "./public-windows-ripgrep-plan.mjs";
import {
  collectMicrosoftPatchNotice,
  collectNativeRuntimeMaterials,
} from "./windows-ripgrep-runtime-materials.mjs";
import {
  archiveName,
  digest,
  parseCargoLock,
  requireValue,
} from "./windows-ripgrep-license-archive.mjs";
import {
  checkedPath,
  isInside,
  originalPackageNotices,
  regularFiles,
} from "./windows-ripgrep-license-files.mjs";
export { parseCargoLock, readCrateArchive } from "./windows-ripgrep-license-archive.mjs";

export const RUST_PIN = Object.freeze({
  channel: sourcePins.toolchain,
  release: sourcePins.rustRelease,
  commit: sourcePins.rustCommit,
  manifestSha256: sourcePins.rustManifestSha256,
});
const RUST_LICENSE_SNAPSHOTS_SHA256 =
  "189fd8f31fd50e9a937cf37585647eb41d4716128ee8687954e0cb209684065f";
const RG_REVISION = sourcePins.sourceCommit;
const TARGETS = new Set(["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]);
const STD_BASE_TARGETS = ["core", "alloc", "std", "compiler_builtins"];

function toolchainFields(text) {
  return Object.fromEntries(
    text.split(/\r?\n/u).flatMap((line) => {
      const match = /^([a-z-]+): (.+)$/u.exec(line);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
}

function manifestSection(text, section) {
  let current = "";
  const lines = [];
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^\[([^\]]+)\]$/u.exec(line.trim());
    if (heading) current = heading[1];
    else if (current === section) lines.push(line);
  }
  const result = {};
  for (const line of lines) {
    const match = /^([a-zA-Z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/u.exec(line.trim());
    if (match) result[match[1]] = JSON.parse(match[2]);
  }
  return result;
}

export function collectGraph(metadata, rootNames) {
  requireValue(
    Array.isArray(metadata.packages) && Array.isArray(metadata.resolve?.nodes),
    "Missing locked Cargo resolve graph",
  );
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const queue = metadata.packages.filter((pkg) => rootNames.has(pkg.name)).map((pkg) => pkg.id);
  requireValue(queue.length >= rootNames.size, "Missing Cargo graph roots");
  const selected = new Map();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (selected.has(id)) continue;
    const pkg = packages.get(id);
    const node = nodes.get(id);
    requireValue(pkg && node, "Cargo graph references an unknown package");
    selected.set(id, pkg);
    for (const dependency of node.deps ?? []) {
      if (
        (dependency.dep_kinds ?? []).some(
          (kind) => kind.kind === null || kind.kind === "normal" || kind.kind === "build",
        )
      )
        queue.push(dependency.pkg);
    }
  }
  return selected;
}

async function pinnedRustSourceNotices(save) {
  const root = new URL("./rust-license-snapshots/", import.meta.url);
  const bytes = await readFile(new URL("manifest.json", root));
  requireValue(
    digest(bytes) === RUST_LICENSE_SNAPSHOTS_SHA256,
    "Pinned Rust source notice inventory changed",
  );
  const manifest = JSON.parse(bytes);
  requireValue(manifest.revision === RUST_PIN.commit, "Rust source notice revision mismatch");
  const result = [];
  for (const record of manifest.records) {
    const source = `https://raw.githubusercontent.com/rust-lang/rust/${RUST_PIN.commit}/${record.path}`;
    requireValue(
      record.source === source && record.snapshot === `${record.sha256}.txt`,
      "Rust original notice source mismatch",
    );
    const content = await readFile(new URL(record.snapshot, root));
    requireValue(
      digest(content) === record.sha256 && content.length === record.bytes,
      "Rust original source notice checksum mismatch",
    );
    result.push({
      source,
      ...(await save(`rust/source-root/${archiveName(record.path)}`, content)),
    });
  }
  return result;
}

export async function collectWindowsRipgrepLicenseMaterials(options) {
  requireValue(TARGETS.has(options.target), "Unsupported Windows ripgrep target");
  requireValue(options.toolchain === RUST_PIN.channel, "Unexpected public Rust channel");
  // macOS /tmp 与 Windows 盘符别名都先归一，避免合法 registry 目录被错当成越界。
  options = {
    ...options,
    sourceDir: await realpath(options.sourceDir),
    cargoHome: await realpath(options.cargoHome),
    rustupHome: await realpath(options.rustupHome),
  };
  const artifactRoot = dirname(options.buildManifest);
  const input = (key, filename) => options[key] ?? join(artifactRoot, filename);
  const files = {
    buildManifest: options.buildManifest,
    cargoLock: input("cargoLock", "Cargo.lock"),
    cargoMetadata: input("cargoMetadata", "cargo-metadata.json"),
    stdCargoLock: input("stdCargoLock", "std-Cargo.lock"),
    stdCargoMetadata: input("stdCargoMetadata", "std-cargo-metadata.json"),
    rustcVv: input("rustcVv", "rustc-vv.txt"),
    channelManifest: input("channelManifest", "rust-channel-manifest.toml"),
    buildMessages: input("buildMessages", "cargo-build-messages.jsonl"),
  };
  const raw = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([key, file]) => [key, await readFile(file)]),
    ),
  );
  const build = JSON.parse(raw.buildManifest);
  const rustc = toolchainFields(raw.rustcVv.toString("utf8"));
  requireValue(build.target === options.target, "Build manifest target mismatch");
  requireValue(build.source?.revision === RG_REVISION, "Unexpected ripgrep source revision");
  requireValue(
    rustc.release === RUST_PIN.release &&
      rustc["commit-hash"] === RUST_PIN.commit &&
      TARGETS.has(rustc.host),
    "Rust compiler release/commit/host mismatch",
  );
  requireValue(
    build.toolchain?.commit === RUST_PIN.commit,
    "Build manifest compiler commit mismatch",
  );
  requireValue(
    digest(raw.channelManifest) === RUST_PIN.manifestSha256,
    "Official dated Rust manifest checksum mismatch",
  );
  const publisher = manifestSection(raw.channelManifest.toString("utf8"), "pkg.rustc");
  requireValue(
    publisher.git_commit_hash === RUST_PIN.commit &&
      publisher.version?.startsWith(RUST_PIN.release),
    "Publisher Rust identity mismatch",
  );
  requireValue(
    digest(raw.cargoLock) === build.source.cargoLockSha256,
    "Build manifest Cargo.lock checksum mismatch",
  );
  requireValue(
    (await readFile(join(options.sourceDir, "Cargo.lock"))).equals(raw.cargoLock),
    "Source Cargo.lock differs from built lock",
  );
  const sysroot = join(options.rustupHome, "toolchains", `${options.toolchain}-${rustc.host}`);
  const rustSource = join(sysroot, "lib/rustlib/src/rust");
  const stdSourceLock = join(rustSource, "library/Cargo.lock");
  requireValue(
    (await readFile(stdSourceLock)).equals(raw.stdCargoLock),
    "rust-src Cargo.lock differs from captured build lock",
  );
  const appGraph = collectGraph(JSON.parse(raw.cargoMetadata), new Set(["ripgrep"]));
  const strategy = build.hardening?.panicStrategy;
  requireValue(strategy === "unwind" || strategy === "abort", "Unknown actual panic strategy");
  const stdTargets = new Set([
    ...STD_BASE_TARGETS,
    strategy === "unwind" ? "panic_unwind" : "panic_abort",
  ]);
  const stdGraph = collectGraph(JSON.parse(raw.stdCargoMetadata), stdTargets);
  requireValue(
    [...appGraph.values()].some((pkg) => pkg.name === "ripgrep" && pkg.version === "14.1.1"),
    "Unexpected ripgrep package version",
  );
  const covered = new Set([...appGraph.keys(), ...stdGraph.keys()]);
  const messages = raw.buildMessages
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  requireValue(
    messages.some((item) => item.reason === "build-finished" && item.success === true),
    "Missing successful Cargo build completion",
  );
  const artifacts = messages.filter((item) => item.reason === "compiler-artifact");
  requireValue(artifacts.length > 0, "Missing actual compiler artifacts");
  for (const artifact of artifacts)
    requireValue(
      covered.has(artifact.package_id),
      `Compiler artifact omitted from license graph: ${artifact.target?.name ?? "unknown"}`,
    );
  for (const name of stdTargets)
    requireValue(
      artifacts.some(
        (artifact) => artifact.target?.name === name && stdGraph.has(artifact.package_id),
      ),
      `Missing rebuilt standard-library artifact: ${name}`,
    );
  const save = async (file, bytes) => {
    const path = resolve(options.outputDir, file);
    requireValue(isInside(resolve(options.outputDir), path), "Unsafe output notice path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return { file: file.split(sep).join("/"), sha256: digest(bytes), bytes: bytes.length };
  };
  let documentation;
  for (const candidate of [join(sysroot, "share/doc/rust"), join(sysroot, "share/doc/rustc")]) {
    try {
      await access(join(candidate, "COPYRIGHT-library.html"));
      documentation = candidate;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  requireValue(documentation, "Missing official Rust standard-library copyright inventory");
  const docNames = await regularFiles(documentation);
  const selectedDocs = docNames.filter(
    (file) =>
      [
        "COPYRIGHT",
        "COPYRIGHT.html",
        "COPYRIGHT-library.html",
        "LICENSE-MIT",
        "LICENSE-APACHE",
      ].includes(file) || file.startsWith("licenses/"),
  );
  for (const file of ["COPYRIGHT.html", "COPYRIGHT-library.html"])
    requireValue(selectedDocs.includes(file), `Missing original Rust notice: ${file}`);
  // 2025-06-26 的 compiler 组件只生成两份 HTML；完整 source LICENSES 从同 commit 固定快照补齐。
  const rustNotices = await pinnedRustSourceNotices(save);
  for (const file of selectedDocs) {
    const bytes = await readFile(await checkedPath(documentation, join(documentation, file)));
    if (file.endsWith(".html")) {
      const html = bytes.toString("utf8");
      requireValue(
        !html.includes("{{") && !html.includes("{%"),
        "Unrendered Rust copyright template",
      );
      for (const match of html.matchAll(/href=["']([^"'#]+)["']/gu)) {
        if (/^(?:https?:|mailto:)/iu.test(match[1])) continue;
        const linked = await checkedPath(
          documentation,
          resolve(documentation, decodeURIComponent(match[1])),
        );
        const linkedName = relative(documentation, linked).split(sep).join("/");
        if (!selectedDocs.includes(linkedName)) selectedDocs.push(linkedName);
      }
    }
    rustNotices.push(await save(`rust/${file}`, bytes));
  }
  // rustc 本体不随程序分发；其完整 COPYRIGHT 只留作构建来源证据。
  const runtimeRustNotices = rustNotices.filter((notice) => notice.file !== "rust/COPYRIGHT.html");
  const packages = [];
  for (const [graphName, graph, lock, workspace] of [
    ["ripgrep", appGraph, parseCargoLock(raw.cargoLock.toString("utf8")), options.sourceDir],
    ["build-std", stdGraph, parseCargoLock(raw.stdCargoLock.toString("utf8")), rustSource],
  ]) {
    for (const pkg of graph.values()) {
      const notices = await originalPackageNotices(
        pkg,
        lock,
        {
          ...options,
          workspaceLicense: [...appGraph.values()].find((item) => item.name === "ripgrep")?.license,
          allowedWorkspaceRoot: workspace,
          rustWorkspace: graphName === "build-std" && !pkg.source,
        },
        runtimeRustNotices,
        save,
      );
      packages.push({
        graph: graphName,
        id: pkg.id,
        name: pkg.name,
        version: pkg.version,
        source: pkg.source ?? "source checkout",
        publisherLicenseIdentifier: pkg.license ?? null,
        ...notices,
      });
    }
  }
  const patchNotice = await collectMicrosoftPatchNotice(build, artifactRoot, sourcePins, save);
  const runtime = await collectNativeRuntimeMaterials(build, save);
  const result = {
    schemaVersion: 1,
    status: runtime.unprovedScope.length ? "incomplete-native-runtime" : "complete",
    target: options.target,
    toolchain: RUST_PIN,
    inputs: Object.fromEntries(
      Object.entries(raw).map(([name, bytes]) => [
        name,
        { sha256: digest(bytes), bytes: bytes.length },
      ]),
    ),
    scope:
      "Locked target-filtered normal/build dependency closure plus actual rebuilt std artifacts; includes build-only components and does not claim every package is linked.",
    compilerArtifacts: artifacts.map((artifact) => ({
      packageId: artifact.package_id,
      name: artifact.target?.name,
      fresh: artifact.fresh,
    })),
    rustNotices,
    rustNoticeCollections: {
      standardLibraryAndConservativeLicenseCorpus: runtimeRustNotices,
      compilerBuildEvidence: rustNotices.filter((notice) => notice.file === "rust/COPYRIGHT.html"),
    },
    packages,
    patchNotice,
    nativeRuntime: runtime.notices,
    nativeRuntimeLibraries: runtime.libraries,
    nativeRuntimePolicySnapshot: runtime.policySnapshot,
    nativeRuntimePublisherOriginals: runtime.publisherOriginals,
    unprovedScope: runtime.unprovedScope,
    completion:
      "All required Rust/Cargo provenance, artifact coverage and original notice byte checks passed; distribution replacement remains a separate gate.",
  };
  await save("materials.json", Buffer.from(JSON.stringify(result, null, 2) + "\n"));
  return result;
}

export function cliOptions(argv) {
  const result = {};
  const keys = [
    "sourceDir",
    "cargoHome",
    "rustupHome",
    "toolchain",
    "target",
    "outputDir",
    "buildManifest",
  ];
  // CI 使用 --name=value；按第一个等号拆分，避免路径中的等号被截断。
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^(--[a-z]+(?:-[a-z]+)*)(?:=(.*))?$/u.exec(argv[index] ?? "");
    requireValue(match, "Expected named material collector arguments");
    const key = match[1].slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    requireValue(keys.includes(key), "Unknown material collector argument");
    const value = match[2] ?? argv[++index];
    requireValue(value && !value.startsWith("--"), "Missing material collector argument value");
    requireValue(!Object.hasOwn(result, key), "Duplicate material collector argument");
    result[key] = value;
  }
  for (const key of keys)
    requireValue(
      result[key],
      `Missing --${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
    );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await collectWindowsRipgrepLicenseMaterials(cliOptions(process.argv.slice(2)));
  console.log(
    `Windows ripgrep materials: ${result.target}, ${result.packages.length} graph records, ${result.rustNotices.length} original Rust notice files`,
  );
  // 审查材料允许保留未证明范围，但 CLI 不能把缺 CRT 原文的包当作可晋级结果。
  if (result.unprovedScope.length) {
    console.error("Incomplete native runtime licensing material; promotion is blocked.");
    process.exitCode = 1;
  }
}
