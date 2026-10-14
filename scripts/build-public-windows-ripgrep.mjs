#!/usr/bin/env node
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as pins,
  assertRustCompilerIdentity,
  createPublicWindowsRipgrepPlan,
  readRustManifestComponents,
  sha256,
} from "./public-windows-ripgrep-plan.mjs";
import {
  execute,
  preparePublicRipgrepSources,
  PCRE2_SOURCE_PINS,
} from "./public-windows-ripgrep-source.mjs";
import {
  assertPePdbBinding,
  bindOfficialRustCompilerComponent,
  readBuildProvenance,
} from "./public-windows-ripgrep-build-evidence.mjs";
import { runPcre2StandardRegression } from "./public-windows-ripgrep-pcre2-regression.mjs";
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
        version: PCRE2_SOURCE_PINS.version,
        advisories: [
          {
            id: "GHSA-r9hj-j2rw-4q3m",
            status: "official-release-source-prepared",
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
    evidence.source.pcre2 = {
      file: "pcre2-source-evidence.json",
      sha256: sha256(await readFile(join(artifacts, "pcre2-source-evidence.json"))),
      version: source.pcre2.version,
      archiveSha256: source.pcre2.archiveSha256,
    };
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
    evidence.toolchain.officialCompiler = await bindOfficialRustCompilerComponent({
      component: installedComponents.find(
        (entry) => entry.component === `pkg.rustc.target.${plan.target}`,
      ),
      sysroot,
      workDir: work,
      artifactsDir: artifacts,
      env,
    });
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
      spectreComponentId: env.UWORK_SPECTRE_COMPONENT_ID,
      spectreInstallationRequested: env.UWORK_SPECTRE_INSTALLATION_REQUESTED,
      spectreLibraries,
      linkSearchOrder: (env.LIB ?? "").split(";"),
      notices: await locateNativeNotices(env),
    };
    evidence.status = "building";
    await save();
    await cargo(plan.cargoBuildArgs, {
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
    evidence.hardening.pdbBinding = assertPePdbBinding(binary, await readFile(pdb));
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
    const compilerLog = await readFile(join(artifacts, "cargo-build-messages.jsonl"), "utf8");
    const provenance = readBuildProvenance(compilerLog);
    Object.assign(evidence.hardening, provenance);
    evidence.hardening.buildLogSha256 = sha256(compilerLog);
    evidence.hardening.rebuiltLibraries = [];
    await mkdir(join(artifacts, "rebuilt-std"));
    for (const path of provenance.linkedArtifacts) {
      const file = `rebuilt-std/${basename(path)}`;
      const bytes = await readFile(path);
      await writeFile(join(artifacts, file), bytes);
      evidence.hardening.rebuiltLibraries.push({ file, buildPath: path, sha256: sha256(bytes) });
    }
    await writeFile(join(artifacts, "rg-link-command.txt"), provenance.linkCommand + "\n");
    await verifyPublicWindowsPeHardening(binaryPath, arch);
    evidence.security.pcre2.standardRegression = await runPcre2StandardRegression({
      source,
      workDir: work,
      artifactsDir: artifacts,
      env,
      plan,
      candidateSha256: evidence.outputs.executableSha256,
    });
    env.CARGO_TARGET_DIR = join(work, "target-tests");
    await cargo(plan.cargoTestArgs, { logPath: join(artifacts, "upstream-test.log") });
    evidence.security.pcre2.upstreamTests = {
      status: "passed",
      file: "upstream-test.log",
      sha256: sha256(await readFile(join(artifacts, "upstream-test.log"))),
      sourceEvidenceSha256: evidence.source.pcre2.sha256,
      candidateSha256: evidence.outputs.executableSha256,
    };
    evidence.security.pcre2.advisories[0].status = "patched";
    evidence.security.pcre2.advisories[0].acceptance =
      "official-updated-release-standard-regression-and-native-cli";
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
