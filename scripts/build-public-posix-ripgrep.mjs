#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as sourcePins,
  assertSha256,
  sha256,
} from "./public-windows-ripgrep-plan.mjs";
import {
  preparePublicRipgrepSources,
  execute,
  fetchPinnedBytes,
} from "./public-windows-ripgrep-source.mjs";
import {
  PUBLIC_POSIX_RIPGREP_PINS as pins,
  createPublicPosixRipgrepPlan,
  assertPosixCompilerIdentity,
  assertPosixPlatformReports,
} from "./public-posix-ripgrep-plan.mjs";
import {
  installPosixRustComponents,
  collectPosixRipgrepMaterials,
} from "./public-posix-ripgrep-materials.mjs";
import {
  NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS,
  NATIVE_SEARCH_DEPENDENCIES_DIR,
} from "./native-search-tools-config.mjs";
import { runRipgrepCompatibility } from "./public-ripgrep-compatibility.mjs";

export async function createDeterministicPosixArchive(binary) {
  const header = Buffer.alloc(512);
  header.write("rg");
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${binary.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(
    `${header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0")}\0 `,
    148,
  );
  return promisify(gzip)(
    Buffer.concat([
      header,
      binary,
      Buffer.alloc((512 - (binary.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}

async function platformReports(plan, binary, env, artifacts) {
  const reports =
    plan.platform === "darwin"
      ? {
          loadCommands: await execute("otool", ["-l", binary], { env, capture: true }),
          dependencies: await execute("otool", ["-L", binary], { env, capture: true }),
        }
      : {
          programHeaders: await execute("readelf", ["-l", binary], { env, capture: true }),
          dynamic: await execute("readelf", ["-d", binary], { env, capture: true }),
          versions: await execute("readelf", ["--version-info", binary], { env, capture: true }),
        };
  assertPosixPlatformReports(plan, await readFile(binary), reports);
  await writeFile(
    join(artifacts, "platform-reports.json"),
    JSON.stringify(reports, null, 2) + "\n",
  );
  return {
    file: "platform-reports.json",
    sha256: sha256(await readFile(join(artifacts, "platform-reports.json"))),
  };
}

export async function buildPublicPosixRipgrep({
  platform = process.platform,
  arch = process.arch,
  workDir,
  artifactsDir,
} = {}) {
  const plan = createPublicPosixRipgrepPlan({ platform, arch });
  const work = resolve(workDir ?? `.tmp/public-posix-ripgrep/${platform}-${arch}/work`);
  const artifacts = resolve(
    artifactsDir ?? `.tmp/public-posix-ripgrep/${platform}-${arch}/artifacts`,
  );
  await mkdir(dirname(work), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const evidence = {
    schemaVersion: 1,
    status: "preparing",
    plan,
    toolchain: pins,
    source: { revision: sourcePins.sourceCommit, archiveSha256: sourcePins.sourceSha256 },
    outputs: {},
    reports: {},
    security: {
      pcre2: {
        version: "10.49",
        validation: "official-post-update-standard-suite-only",
        independentPoc: "not-run",
      },
    },
    promotion: "not-performed",
  };
  const save = () =>
    writeFile(join(artifacts, "build-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  try {
    const source = await preparePublicRipgrepSources(work, artifacts, {
      url: pins.manifestUrl,
      sha256: pins.manifestSha256,
    });
    evidence.source.pcre2 = {
      file: "pcre2-source-evidence.json",
      sha256: sha256(await readFile(join(artifacts, "pcre2-source-evidence.json"))),
    };
    evidence.source.cargoLockSha256 = source.cargoLockSha256;
    evidence.source.sourceDir = source.sourceDir;
    evidence.source.workDir = work;
    await copyFile(join(work, "ripgrep-source.tar.gz"), join(artifacts, "ripgrep-source.tar.gz"));
    evidence.source.archive = { file: "ripgrep-source.tar.gz", sha256: sourcePins.sourceSha256 };
    await copyFile(join(source.sourceDir, "Cargo.toml"), join(artifacts, "prepared-Cargo.toml"));
    evidence.source.posixProducer = [];
    for (const item of pins.producerSources) {
      const url = `https://raw.githubusercontent.com/microsoft/ripgrep-prebuilt/${sourcePins.microsoftProducer}/${item.path}`;
      const file = `microsoft-posix-${item.path.replaceAll("/", "-")}`;
      await writeFile(join(artifacts, file), await fetchPinnedBytes(url, item.sha256, item.path));
      evidence.source.posixProducer.push({ file, source: url, sha256: item.sha256 });
    }
    await save();
    const installed = await installPosixRustComponents(work, artifacts, plan, source.manifest);
    evidence.toolchain = { ...pins, ...installed };
    const env = {
      ...process.env,
      PATH: `${join(installed.prefix, "bin")}:${process.env.PATH ?? ""}`,
      CARGO_HOME: join(work, "cargo-home"),
      CARGO_TARGET_DIR: join(work, "target"),
      GIT_CEILING_DIRECTORIES: work,
      RIPGREP_BUILD_GIT_HASH: sourcePins.sourceCommit.slice(0, 10),
      PCRE2_SYS_STATIC: "1",
      CARGO_TERM_COLOR: "never",
    };
    for (const key of Object.keys(env))
      if (
        key.startsWith("CARGO_PROFILE_") ||
        (key.startsWith("CARGO_TARGET_") && key !== "CARGO_TARGET_DIR") ||
        [
          "RUSTFLAGS",
          "CARGO_ENCODED_RUSTFLAGS",
          "RUSTC_BOOTSTRAP",
          "RUSTC",
          "RUSTC_WRAPPER",
          "RUSTC_WORKSPACE_WRAPPER",
          "CFLAGS",
          "CXXFLAGS",
          "CC",
          "CXX",
        ].includes(key)
      )
        delete env[key];
    Object.assign(env, {
      CARGO_PROFILE_RELEASE_DEBUG: plan.profile.debug,
      CARGO_PROFILE_RELEASE_STRIP: plan.profile.strip,
      CARGO_PROFILE_RELEASE_LTO: plan.profile.lto,
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: plan.profile.codegenUnits,
    });
    if (platform === "darwin") env.MACOSX_DEPLOYMENT_TARGET = plan.macosDeploymentTarget;
    else {
      env.CC = "musl-gcc";
      env[`CARGO_TARGET_${plan.target.toUpperCase().replaceAll("-", "_")}_LINKER`] = "musl-gcc";
    }
    if (plan.jemallocPage) env.JEMALLOC_SYS_WITH_LG_PAGE = plan.jemallocPage;
    const rustc = join(installed.prefix, "bin/rustc"),
      cargoBinary = join(installed.prefix, "bin/cargo");
    const identity = await execute(rustc, ["-vV"], {
      env,
      capture: true,
      logPath: join(artifacts, "rustc-vv.txt"),
    });
    evidence.toolchain.identity = assertPosixCompilerIdentity(identity, plan.host);
    evidence.toolchain.compilerSha256 = sha256(await readFile(rustc));
    evidence.toolchain.cargoSha256 = sha256(await readFile(cargoBinary));
    evidence.toolchain.cargoVersion = await execute(cargoBinary, ["--version"], {
      env,
      capture: true,
    });
    evidence.toolchain.nativeCompiler = await execute(
      platform === "darwin" ? "clang" : "musl-gcc",
      ["--version"],
      { env, capture: true, logPath: join(artifacts, "c-compiler.txt") },
    );
    if (platform === "darwin")
      evidence.toolchain.sdk = await execute("xcrun", ["--show-sdk-version"], {
        env,
        capture: true,
      });
    else evidence.toolchain.linker = await execute("ld.lld", ["--version"], { env, capture: true });
    const cargo = (args, log) =>
      execute(cargoBinary, args, {
        cwd: source.sourceDir,
        env,
        capture: true,
        logPath: log && join(artifacts, log),
      });
    const metadataText = await cargo(
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
      "cargo-metadata.json",
    );
    // Cargo 下载进度写 stderr；metadata 归档必须只保留 stdout 的完整 JSON。
    await writeFile(join(artifacts, "cargo-metadata.json"), metadataText);
    evidence.status = "building";
    await save();
    const rawBuild = await cargo(plan.buildArgs, "cargo-build-messages.jsonl");
    const messages = rawBuild
      .split(/\r?\n/u)
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    const built = join(env.CARGO_TARGET_DIR, plan.target, "release/rg");
    await copyFile(built, join(artifacts, "rg"));
    const binary = await readFile(built);
    evidence.outputs.executableSha256 = sha256(binary);
    if (!binary.includes(Buffer.from(pins.rustCommit)))
      throw new Error("Candidate lacks original public Rust std revision marker");
    evidence.reports.platform = await platformReports(plan, built, env, artifacts);
    const archiveName = `ripgrep-v14.1.1-uwork-pcre2-10.49-1-${plan.target}.tar.gz`;
    const archive = await createDeterministicPosixArchive(binary);
    await writeFile(join(artifacts, archiveName), archive);
    Object.assign(evidence.outputs, { archiveName, archiveSha256: sha256(archive) });
    const version = await execute(built, ["--version"], {
      env,
      capture: true,
      logPath: join(artifacts, "rg-version.txt"),
    });
    if (
      plan.jit ? !version.includes("JIT is available") : !version.includes("JIT is not available")
    )
      throw new Error("Target rg JIT policy changed");
    await cargo(plan.testArgs, "upstream-test.log");
    evidence.reports.upstream = {
      status: "passed",
      exitCode: 0,
      command: plan.testArgs,
      file: "upstream-test.log",
      sha256: sha256(await readFile(join(artifacts, "upstream-test.log"))),
      nativePlatform: platform,
      nativeArch: arch,
    };
    const original = NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS[`${platform}-${arch}`];
    const baselineArchive = join(
      NATIVE_SEARCH_DEPENDENCIES_DIR,
      `ripgrep-v14.1.1-1/${original.releaseFileName}`,
    );
    assertSha256(
      await readFile(baselineArchive),
      original.sha256,
      "Original POSIX compatibility baseline",
    );
    const baseline = join(work, "baseline");
    await mkdir(baseline);
    await execute("tar", ["-xzf", baselineArchive, "-C", baseline], { capture: true });
    const cases = await runRipgrepCompatibility({
      candidate: built,
      baseline: join(baseline, "rg"),
      fixtureDir: join(work, "compatibility-fixture"),
      requireJit: plan.jit,
    });
    const compatibility = {
      nativePlatform: platform,
      nativeArch: arch,
      candidateSha256: sha256(binary),
      baselineArchiveSha256: original.sha256,
      baselineExecutableSha256: sha256(await readFile(join(baseline, "rg"))),
      cases,
    };
    await writeFile(
      join(artifacts, "compatibility.json"),
      JSON.stringify(compatibility, null, 2) + "\n",
    );
    const cEnv = { ...env, CC: platform === "darwin" ? "clang" : "musl-gcc" };
    if (platform === "linux") cEnv.LDFLAGS = "-static";
    delete cEnv.CARGO_TARGET_DIR;
    await execute(
      "sh",
      ["./configure", "--enable-pcre2-16", "--enable-pcre2-32", "--enable-jit", "--disable-shared"],
      {
        cwd: source.pcre2.releaseDir,
        env: cEnv,
        capture: true,
        logPath: join(artifacts, "pcre2-configure.log"),
      },
    );
    await execute("make", ["-j4"], {
      cwd: source.pcre2.releaseDir,
      env: cEnv,
      capture: true,
      logPath: join(artifacts, "pcre2-build.log"),
    });
    const ctests = await execute("make", ["check"], {
      cwd: source.pcre2.releaseDir,
      env: cEnv,
      capture: true,
      logPath: join(artifacts, "pcre2-test.log"),
    });
    for (const name of ["pcre2posix_test", "pcre2_jit_test", "RunTest", "RunGrepTest"])
      if (!ctests.includes(`PASS: ${name}`))
        throw new Error(`Missing updated PCRE2 standard test ${name}`);
    for (const label of ["SKIP", "FAIL", "ERROR"])
      if (!new RegExp(`# ${label}:\\s+0\\b`, "u").test(ctests))
        throw new Error(`PCRE2 standard suite has ${label} results`);
    evidence.reports.pcre2Standard = {
      status: "passed",
      exitCode: 0,
      command: ["make", "check"],
      nativePlatform: platform,
      nativeArch: arch,
      testNames: ["pcre2posix_test", "pcre2_jit_test", "RunTest", "RunGrepTest"],
      version: "10.49",
      file: "pcre2-test.log",
      sha256: sha256(await readFile(join(artifacts, "pcre2-test.log"))),
    };
    for (const [file, hash] of Object.entries(source.pcre2.preparedFiles))
      assertSha256(
        await readFile(join(source.sourceDir, "vendor/pcre2-sys", file)),
        hash,
        `Prepared source ${file}`,
      );
    assertSha256(
      await readFile(join(source.sourceDir, "Cargo.lock")),
      source.cargoLockSha256,
      "Cargo lock after build/test",
    );
    const materials = await collectPosixRipgrepMaterials({
      sourceDir: source.sourceDir,
      cargoHome: env.CARGO_HOME,
      prefix: installed.prefix,
      metadata: JSON.parse(metadataText),
      artifacts,
      plan,
      buildMessages: messages,
    });
    evidence.reports.materials = {
      file: "materials/materials.json",
      sha256: sha256(await readFile(join(artifacts, "materials/materials.json"))),
      status: materials.status,
      unprovedScope: materials.unprovedScope,
    };
    for (const file of [
      "upstream-test.log",
      "compatibility.json",
      "rustc-vv.txt",
      "cargo-metadata.json",
      "cargo-build-messages.jsonl",
    ])
      evidence.reports[file] = { file, sha256: sha256(await readFile(join(artifacts, file))) };
    evidence.status = "native-candidate-awaiting-independent-seal";
    await save();
    return evidence;
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error.message;
    await save();
    throw error;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const option = (name) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    await buildPublicPosixRipgrep({
      platform: option("platform"),
      arch: option("arch"),
      workDir: option("work-dir"),
      artifactsDir: option("output-dir"),
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
