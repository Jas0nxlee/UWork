import assert from "node:assert/strict";
import { verifyMacosDeploymentTarget } from "./native-search-tools-verify.mjs";

export const PUBLIC_POSIX_RIPGREP_PINS = Object.freeze({
  toolchain: "1.88.0",
  rustCommit: "6b00bc3880198600130e1cf62b8f8a93494488cc",
  manifestUrl: "https://static.rust-lang.org/dist/2025-06-26/channel-rust-1.88.0.toml",
  manifestSha256: "431b7c5c0b9a511d8e31d29b378bbc74124e8521f14beb92d3a5a5f7e7e55449",
  producerSources: [
    {
      path: "build/install.sh",
      sha256: "c3c8901e4e8c4b22aa8dcd18b51bb8e90a0f334f2fbbc39f9a20a7ca5e314faf",
    },
    {
      path: "build/build.sh",
      sha256: "56a2dae7e42f06fa632687aaee1a75a89e562c8cdf62af55d16abfb83b83f142",
    },
    {
      path: "build/linux.yml",
      sha256: "9dabd4ac8cfa579feca2c624c3b8ab3cd82d098bb75accec2c3bf444fde16623",
    },
  ],
  sourceNotices: [
    {
      path: "LICENSE-MIT",
      sha256: "b71bd43a069ca0641a9ecfe585ca7b3c53b5cc1608f8b68321168698e28b5ea1",
    },
    {
      path: "LICENSE-APACHE",
      sha256: "62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a",
    },
    {
      path: "COPYRIGHT",
      sha256: "172020dbfd5b53a226dfde77616190a48dcff519b0bc0e6deb91a8450782c4af",
    },
  ],
});

export function createPublicPosixRipgrepPlan({
  platform = process.platform,
  arch = process.arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
  env = process.env,
} = {}) {
  if (!["darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(arch))
    throw new Error(`Unsupported POSIX target ${platform}-${arch}`);
  if (env.RUSTC_BOOTSTRAP) throw new Error("RUSTC_BOOTSTRAP is forbidden");
  if (platform !== hostPlatform || arch !== hostArch)
    throw new Error(`POSIX ${platform}-${arch} requires a matching native runner`);
  const cpu = arch === "arm64" ? "aarch64" : "x86_64";
  const target = platform === "darwin" ? `${cpu}-apple-darwin` : `${cpu}-unknown-linux-musl`;
  const host = platform === "darwin" ? target : `${cpu}-unknown-linux-gnu`;
  return Object.freeze({
    platform,
    arch,
    target,
    host,
    toolchain: PUBLIC_POSIX_RIPGREP_PINS.toolchain,
    jit: arch === "x64",
    macosDeploymentTarget: platform === "darwin" ? "12.0" : null,
    jemallocPage: platform === "linux" && arch === "arm64" ? "16" : null,
    // Microsoft 固定 POSIX install.sh 的 release 配置；不引入 Windows 的 std 重编译。
    profile: { debug: "0", strip: "true", lto: "true", codegenUnits: "1", panic: "unwind" },
    buildArgs: [
      "build",
      "--release",
      "--locked",
      "--target",
      target,
      "--features",
      "pcre2",
      "--message-format=json",
      "-vv",
    ],
    testArgs: ["test", "--release", "--locked", "--all", "--target", target, "--features", "pcre2"],
  });
}

export function assertPosixCompilerIdentity(output, host) {
  const fields = Object.fromEntries(
    output.split(/\r?\n/u).flatMap((line) => {
      const m = /^([a-z-]+): (.+)$/u.exec(line);
      return m ? [[m[1], m[2]]] : [];
    }),
  );
  assert.equal(fields.release, PUBLIC_POSIX_RIPGREP_PINS.toolchain, "Public Rust release mismatch");
  assert.equal(
    fields["commit-hash"],
    PUBLIC_POSIX_RIPGREP_PINS.rustCommit,
    "Public Rust revision mismatch",
  );
  assert.equal(fields.host, host, "Public Rust host mismatch");
  return fields;
}

export function readPosixRustComponents(manifest, plan) {
  const sections = manifest.split(/^\[([^\n]+)\]\s*$/mu);
  const records = new Map();
  for (let i = 1; i < sections.length; i += 2) records.set(sections[i], sections[i + 1]);
  const keys = [
    `pkg.rustc.target.${plan.host}`,
    `pkg.cargo.target.${plan.host}`,
    ...new Set([plan.host, plan.target].map((t) => `pkg.rust-std.target.${t}`)),
    'pkg.rust-src.target."*"',
  ];
  return keys.map((component) => {
    const section = records.get(component) ?? "";
    const url = section.match(/^xz_url = "([^"]+)"/mu)?.[1];
    const hash = section.match(/^xz_hash = "([a-f0-9]{64})"/mu)?.[1];
    if (
      !section.includes("available = true") ||
      !url?.startsWith("https://static.rust-lang.org/dist/2025-06-26/") ||
      !hash
    )
      throw new Error(`Invalid pinned Rust component ${component}`);
    return { component, url, sha256: hash };
  });
}

export function assertPosixPlatformReports(plan, binary, reports) {
  if (plan.platform === "darwin") {
    assert.ok(
      binary.length >= 32 && binary.readUInt32LE(0) === 0xfeedfacf && binary.readUInt32LE(12) === 2,
      "Expected Mach-O executable",
    );
    assert.equal(
      binary.readUInt32LE(4),
      plan.arch === "arm64" ? 0x100000c : 0x1000007,
      "Mach-O architecture mismatch",
    );
    verifyMacosDeploymentTarget(reports.loadCommands, "rg");
    const dependencies = reports.dependencies
      .split(/\r?\n/u)
      .slice(1)
      .map((l) => l.trim().split(" ")[0])
      .filter(Boolean);
    assert.ok(dependencies.length > 0, "Missing Mach-O dependencies");
    for (const lib of dependencies)
      assert.ok(
        ["/usr/lib/libSystem.B.dylib", "/usr/lib/libiconv.2.dylib"].includes(lib),
        `Non-system Mach-O dependency ${lib}`,
      );
  } else {
    assert.ok(
      binary.length >= 64 &&
        binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        binary[4] === 2 &&
        binary[5] === 1,
      "Expected ELF64 executable",
    );
    assert.ok([2, 3].includes(binary.readUInt16LE(16)), "Expected ELF executable type");
    assert.equal(
      binary.readUInt16LE(18),
      plan.arch === "arm64" ? 0xb7 : 0x3e,
      "ELF architecture mismatch",
    );
    for (const key of ["programHeaders", "dynamic", "versions"])
      assert.ok(reports[key]?.trim(), `Missing ELF ${key}`);
    assert.doesNotMatch(
      reports.programHeaders,
      /\bINTERP\b/u,
      "musl binary must not require an interpreter",
    );
    assert.doesNotMatch(reports.dynamic, /\(NEEDED\)/u, "musl binary must be fully static");
    assert.doesNotMatch(reports.versions, /\bGLIBC_/u, "musl binary must not require glibc");
  }
}
