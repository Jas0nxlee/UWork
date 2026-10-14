#!/usr/bin/env node
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as pins,
  assertRustCompilerIdentity,
  createPublicWindowsRipgrepPlan,
  readRustManifestComponents,
  sha256,
} from "./public-windows-ripgrep-plan.mjs";
import { execute, preparePublicRipgrepSources } from "./public-windows-ripgrep-source.mjs";
import { createDeterministicRipgrepZip } from "./public-windows-ripgrep-archive.mjs";
import {
  verifyPublicWindowsPeHardening,
  parsePublicWindowsPeHardening,
} from "./public-windows-ripgrep-hardening.mjs";

function option(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
async function locateNativeNotices(env) {
  const roots = [
    join(env.VSINSTALLDIR ?? "", "Licenses"),
    join(env.VCINSTALLDIR ?? "", "Redist"),
    join(env.VSINSTALLDIR ?? "", "Common7", "IDE", "Licenses"),
  ].filter(
    (path) =>
      !path.startsWith("Licenses") && !path.startsWith("Redist") && !path.startsWith("Common7"),
  );
  const notices = [];
  async function visit(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth > 0) await visit(path, depth - 1);
      else if (entry.isFile() && /license|redist.*\.txt$|eula/iu.test(entry.name))
        notices.push({
          path,
          source: "installed Microsoft Visual Studio/MSVC redistribution material",
          sha256: sha256(await readFile(path)),
        });
    }
  }
  for (const root of roots) await visit(root, 4);
  return notices;
}

export async function buildPublicWindowsRipgrep({
  arch,
  workDir,
  artifactsDir,
  prepareOnly = false,
} = {}) {
  const plan = createPublicWindowsRipgrepPlan({ arch, prepareOnly });
  const work = resolve(workDir ?? `.tmp/public-windows-ripgrep/${arch}/work`);
  const artifacts = resolve(artifactsDir ?? `.tmp/public-windows-ripgrep/${arch}/artifacts`);
  await mkdir(dirname(work), { recursive: true });
  const manifestPath = join(artifacts, "build-evidence.json");
  const evidence = {
    schemaVersion: 1,
    status: "preparing",
    target: plan.target,
    arch,
    toolchain: {
      channel: pins.toolchain,
      date: "2025-06-26",
      release: pins.rustRelease,
      commit: pins.rustCommit,
      manifestSha256: pins.rustManifestSha256,
    },
    source: {
      revision: pins.sourceCommit,
      archiveSha256: pins.sourceSha256,
      patchSha256: pins.patchSha256,
      patchLicense: {
        file: "microsoft-producer-LICENSE",
        source: pins.patchLicenseUrl,
        sha256: pins.patchLicenseSha256,
      },
    },
    hardening: {
      stdRebuildRequired: true,
      panicStrategy: "unwind",
      rustFlags: plan.rustFlags,
      cflags: plan.cflags,
      rustcBootstrap: false,
    },
    security: {
      pcre2: {
        version: "10.43",
        advisories: [
          {
            id: "GHSA-r9hj-j2rw-4q3m",
            status: "baseline-unpatched",
            regressionStatus: "not-run",
            advisoryUrl:
              "https://github.com/PCRE2Project/pcre2/security/advisories/GHSA-r9hj-j2rw-4q3m",
          },
        ],
      },
    },
    outputs: {},
  };
  const save = () => writeFile(manifestPath, JSON.stringify(evidence, null, 2) + "\n");
  try {
    const source = await preparePublicRipgrepSources(work, artifacts);
    evidence.source.sourceDir = source.sourceDir;
    evidence.source.cargoLockSha256 = source.cargoLockSha256;
    evidence.toolchain.componentHashes = readRustManifestComponents(source.manifest, plan.target);
    await save();
    if (prepareOnly) {
      evidence.status = "source-prepared-only";
      await save();
      return evidence;
    }
    const cargoHome = join(work, "cargo-home");
    const rustupHome = join(work, "rustup-home");
    const env = {
      ...process.env,
      CARGO_HOME: cargoHome,
      RUSTUP_HOME: rustupHome,
      RUSTUP_DIST_SERVER: "https://static.rust-lang.org",
      RUSTUP_UPDATE_ROOT: "https://static.rust-lang.org/rustup",
      GIT_CEILING_DIRECTORIES: work,
      RIPGREP_BUILD_GIT_HASH: pins.sourceCommit.slice(0, 10),
      CARGO_TARGET_DIR: join(work, "target"),
      CFLAGS: plan.cflags,
      CXXFLAGS: plan.cflags,
      PCRE2_SYS_STATIC: "1",
      CARGO_TERM_COLOR: "never",
    };
    delete env.RUSTFLAGS;
    delete env.RUSTC_BOOTSTRAP;
    delete env.RUSTC;
    delete env.RUSTC_WRAPPER;
    delete env.RUSTC_WORKSPACE_WRAPPER;
    for (const key of Object.keys(env)) if (key.startsWith("CARGO_PROFILE_")) delete env[key];
    evidence.toolchain.cargoHome = cargoHome;
    evidence.toolchain.rustupHome = rustupHome;
    await execute("rustup.exe", ["set", "default-host", plan.target], { env });
    await execute(
      "rustup.exe",
      [
        "toolchain",
        "install",
        plan.toolchain,
        "--profile",
        "minimal",
        "--component",
        "rust-src",
        "--target",
        plan.target,
      ],
      { env, logPath: join(artifacts, "rustup-install.log") },
    );
    const rustc = await execute("rustup.exe", ["run", plan.toolchain, "rustc", "-vV"], {
      env,
      capture: true,
    });
    evidence.toolchain.identity = assertRustCompilerIdentity(rustc, plan.target);
    await writeFile(join(artifacts, "rustc-vv.txt"), rustc);
    const sysroot = (
      await execute("rustup.exe", ["run", plan.toolchain, "rustc", "--print", "sysroot"], {
        env,
        capture: true,
      })
    ).trim();
    const installedManifest = await readFile(
      join(sysroot, "lib", "rustlib", "multirust-channel-manifest.toml"),
    );
    const installedComponents = readRustManifestComponents(
      installedManifest.toString("utf8"),
      plan.target,
    );
    if (JSON.stringify(installedComponents) !== JSON.stringify(evidence.toolchain.componentHashes))
      throw new Error(
        "Installed Rust component origin/hash differs from the pinned official manifest",
      );
    await writeFile(join(artifacts, "installed-channel-manifest.toml"), installedManifest);
    evidence.toolchain.installedManifestSha256 = sha256(installedManifest);
    evidence.toolchain.installedComponentHashes = installedComponents;
    evidence.toolchain.compilerSha256 = sha256(await readFile(join(sysroot, "bin", "rustc.exe")));
    const stdSource = join(sysroot, "lib", "rustlib", "src", "rust", "library");
    evidence.toolchain.sysroot = sysroot;
    evidence.toolchain.stdSource = stdSource;
    const stdLock = await readFile(join(stdSource, "Cargo.lock"));
    evidence.toolchain.stdCargoLockSha256 = sha256(stdLock);
    await writeFile(join(artifacts, "std-Cargo.lock"), stdLock);
    env.CARGO_ENCODED_RUSTFLAGS = [
      ...plan.rustFlags,
      `--remap-path-prefix=${join(sysroot, "lib", "rustlib", "src", "rust")}=/rustc/${pins.rustCommit}`,
      `--remap-path-prefix=${work}=/uwork-public-rg`,
    ].join("\x1f");
    const cargo = (args, options = {}) =>
      execute("rustup.exe", ["run", plan.toolchain, "cargo", ...args], {
        cwd: source.sourceDir,
        env,
        ...options,
      });
    await writeFile(
      join(artifacts, "cargo-metadata.json"),
      await cargo(
        [
          "metadata",
          "--format-version",
          "1",
          "--locked",
          "--features",
          "pcre2",
          "--filter-platform",
          plan.target,
        ],
        { capture: true },
      ),
    );
    await writeFile(
      join(artifacts, "std-cargo-metadata.json"),
      await cargo(
        [
          "metadata",
          "--format-version",
          "1",
          "--locked",
          "--manifest-path",
          join(stdSource, "Cargo.toml"),
          "--filter-platform",
          plan.target,
        ],
        { capture: true },
      ),
    );
    const spectreDir = resolve(env.VCToolsInstallDir ?? "", "lib", "spectre", arch);
    const firstLib = (env.LIB ?? "").split(";")[0];
    if (!firstLib || resolve(firstLib).toLowerCase() !== spectreDir.toLowerCase())
      throw new Error("Spectre CRT directory must be first in LIB");
    if (!(env.VCToolsVersion ?? "").startsWith("14.44."))
      throw new Error("The audited v143 MSVC 14.44 toolset is required");
    const spectreLibraries = [];
    for (const name of ["libcmt.lib", "libvcruntime.lib", "libcpmt.lib"]) {
      const path = join(spectreDir, name);
      spectreLibraries.push({ path, sha256: sha256(await readFile(path)) });
    }
    evidence.nativeRuntime = {
      visualStudioVersion: env.UWORK_VS_INSTALLATION_VERSION,
      vcToolsVersion: env.VCToolsVersion,
      vcToolsInstallDir: env.VCToolsInstallDir,
      windowsSdkVersion: env.WindowsSDKVersion,
      spectreDirectory: spectreDir,
      spectreLibraries,
      linkSearchOrder: (env.LIB ?? "").split(";"),
      notices: await locateNativeNotices(env),
    };
    evidence.status = "building";
    await save();
    const build = await cargo(plan.cargoBuildArgs, {
      capture: true,
      logPath: join(artifacts, "cargo-build-messages.jsonl"),
    });
    const binaryPath = join(env.CARGO_TARGET_DIR, plan.target, "release", "rg.exe");
    const binary = await readFile(binaryPath);
    evidence.outputs.executableSha256 = sha256(binary);
    await writeFile(join(artifacts, "rg.exe"), binary);
    const pdb = join(dirname(binaryPath), "rg.pdb");
    if (!(await stat(pdb)).isFile())
      throw new Error("The original release profile must emit an auditable PDB");
    await copyFile(pdb, join(artifacts, "rg.pdb"));
    evidence.outputs.pdbSha256 = sha256(await readFile(pdb));
    const archive = createDeterministicRipgrepZip(binary);
    const archiveName = `ripgrep-v14.1.1-uwork-public-1-${plan.target}.zip`;
    await writeFile(join(artifacts, archiveName), archive);
    evidence.outputs.archiveName = archiveName;
    evidence.outputs.archiveSha256 = sha256(archive);
    await execute("dumpbin.exe", ["/headers", "/loadconfig", "/imports", binaryPath], {
      env,
      capture: true,
      logPath: join(artifacts, "dumpbin-hardening.txt"),
    });
    evidence.hardening.pe = parsePublicWindowsPeHardening(binary);
    await save();
    const messages = build
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const stdBuild = messages.find(
      (message) =>
        message.reason === "compiler-artifact" &&
        message.target?.name === "std" &&
        message.fresh === false,
    );
    if (!stdBuild) throw new Error("Build did not prove a fresh, instrumented std compilation");
    const panicBuild = messages.find(
      (message) =>
        message.reason === "compiler-artifact" &&
        message.target?.name === "panic_unwind" &&
        message.fresh === false,
    );
    if (!panicBuild)
      throw new Error("Build did not prove the original unwind panic runtime was recompiled");
    evidence.hardening.panicArtifact = panicBuild;
    evidence.hardening.stdArtifact = stdBuild;
    const compilerLog = await readFile(join(artifacts, "cargo-build-messages.jsonl"), "utf8");
    const stdCommand = compilerLog
      .split(/\r?\n/u)
      .find(
        (line) => line.includes("--crate-name std ") && /-C\s*control-flow-guard=yes/u.test(line),
      );
    if (!stdCommand) throw new Error("Missing actual std compiler command with CFG enforcement");
    if (/D9002|ignoring unknown option|argument unused.*control-flow-guard/iu.test(compilerLog))
      throw new Error("A required hardening flag was ignored by the compiler");
    evidence.hardening.stdCompilerCommand = stdCommand;
    await verifyPublicWindowsPeHardening(binaryPath, arch);
    if (!binary.includes(Buffer.from(pins.rustCommit)))
      throw new Error("Executable lacks the expected rebuilt std source revision marker");
    env.CARGO_TARGET_DIR = join(work, "target-tests");
    await cargo(plan.cargoTestArgs, { logPath: join(artifacts, "upstream-test.log") });
    if (
      sha256(await readFile(join(source.sourceDir, "Cargo.lock"))) !== source.cargoLockSha256 ||
      sha256(await readFile(join(stdSource, "Cargo.lock"))) !==
        evidence.toolchain.stdCargoLockSha256
    )
      throw new Error("Cargo lock drifted during the build");
    evidence.status = "built-awaiting-compatibility-and-binskim";
    await save();
    return evidence;
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error.message;
    await mkdir(artifacts, { recursive: true });
    await save();
    throw error;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await buildPublicWindowsRipgrep({
      arch: option("arch") ?? process.arch,
      workDir: option("work-dir"),
      artifactsDir: option("output-dir"),
      prepareOnly: process.argv.includes("--prepare-only"),
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
