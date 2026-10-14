import { createHash } from "node:crypto";

export const PUBLIC_WINDOWS_RIPGREP_PINS = Object.freeze({
  version: "14.1.1",
  sourceCommit: "4649aa9700619f94cf9c66876e9549d83420e16c",
  sourceUrl: "https://codeload.github.com/BurntSushi/ripgrep/tar.gz/4649aa9700",
  sourceSha256: "eb75b0feb6e0d369d30d35f0dafb3f69225c496d057da3990651f1ad9c093706",
  microsoftProducer: "7ea8b7eb6c0de96fe4275bba5e88cb49297af42e",
  patchUrl:
    "https://raw.githubusercontent.com/microsoft/ripgrep-prebuilt/7ea8b7eb6c0de96fe4275bba5e88cb49297af42e/patches/0001-resolve-binskim-issues.patch",
  patchLicenseUrl:
    "https://raw.githubusercontent.com/microsoft/ripgrep-prebuilt/7ea8b7eb6c0de96fe4275bba5e88cb49297af42e/LICENSE",
  patchLicenseSha256: "dea9265341829002e2c23a7372393eb2ed6e26085fb623f38a4ba0af833f30a6",
  patchSha256: "8cf3c2eeeb4261d66a838f7fe8a8e9870a6ce3a7f1c1d3a2a9d5e36b5a947cac",
  toolchain: "nightly-2025-06-26",
  rustRelease: "1.90.0-nightly",
  rustCommit: "0fa4ec6cde46fa17ab07acb5531cfe0dc1349ffa",
  rustManifestUrl: "https://static.rust-lang.org/dist/2025-06-26/channel-rust-nightly.toml",
  rustManifestSha256: "4ab56f5eae0b8d5a58ce20c5197117be9facc4edceca01f8122f7aaf5baf9645",
});

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
export function assertSha256(bytes, expected, label) {
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: ${actual} != ${expected}`);
  return actual;
}

export function createPublicWindowsRipgrepPlan({
  arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
  env = process.env,
  prepareOnly = false,
} = {}) {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`Unsupported Windows architecture: ${arch}`);
  if (!prepareOnly && hostPlatform !== "win32")
    throw new Error("The compatibility build must run on native Windows");
  if (!prepareOnly && hostArch !== arch)
    throw new Error(`The ${arch} candidate requires a native ${arch} host, received ${hostArch}`);
  if (env.RUSTC_BOOTSTRAP) throw new Error("RUSTC_BOOTSTRAP is forbidden for the public candidate");
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const rustFlags = [
    "-Ccontrol-flow-guard=yes",
    "-Ctarget-feature=+crt-static",
    "-Clink-arg=/DYNAMICBASE",
    "-Clink-arg=/HIGHENTROPYVA",
    "-Clink-arg=/NXCOMPAT",
  ];
  if (arch === "x64") rustFlags.push("-Clink-arg=/CETCOMPAT");
  return Object.freeze({
    arch,
    target,
    toolchain: PUBLIC_WINDOWS_RIPGREP_PINS.toolchain,
    rustFlags,
    cflags: "/guard:cf /Qspectre /W3",
    cargoBuildArgs: [
      "build",
      "--release",
      "--locked",
      "--target",
      target,
      "--features",
      "pcre2",
      "-Zbuild-std=std,panic_unwind",
      "--message-format=json",
      "-vv",
    ],
    cargoTestArgs: [
      "test",
      "--release",
      "--locked",
      "--all",
      "--target",
      target,
      "--features",
      "pcre2",
      "-Zbuild-std=std,panic_unwind",
    ],
  });
}

export function stripPrivateCargoRegistry(config) {
  const sections = config.split(/(?=^\[)/mu);
  const removed = new Set();
  const result = sections
    .filter((section) => {
      const header = section.split(/\r?\n/u, 1)[0];
      if (
        header === `[target.'cfg(target_os = "windows")'.source.crates-io]` ||
        header === "[registries.ms-crates-io]"
      ) {
        removed.add(header);
        return false;
      }
      return true;
    })
    .join("");
  if (removed.size !== 2)
    throw new Error("Original Microsoft private registry sections were not found exactly");
  if (/ms-crates-io|pkgs\.dev\.azure|^\s*(?:index|replace-with)\s*=/mu.test(result))
    throw new Error("Unexpected Cargo registry redirect remains");
  for (const flag of [
    "-Ccontrol-flow-guard",
    "-Ctarget-feature=+crt-static",
    "/DYNAMICBASE /CETCOMPAT",
  ]) {
    if (!result.includes(flag)) throw new Error(`Original hardening flag was lost: ${flag}`);
  }
  return result;
}

export function assertRustCompilerIdentity(output, expectedHost) {
  const fields = Object.fromEntries(
    output.split(/\r?\n/u).flatMap((line) => {
      const index = line.indexOf(": ");
      return index < 0 ? [] : [[line.slice(0, index), line.slice(index + 2)]];
    }),
  );
  if (fields["commit-hash"] !== PUBLIC_WINDOWS_RIPGREP_PINS.rustCommit)
    throw new Error("Public rustc commit mismatch");
  if (fields.release !== PUBLIC_WINDOWS_RIPGREP_PINS.rustRelease)
    throw new Error("Public rustc release mismatch");
  if (fields.host !== expectedHost) throw new Error("Public rustc host architecture mismatch");
  return fields;
}

export function readRustManifestComponents(manifest, target) {
  const entries = manifest.split(/^\[([^\n]+)\]\s*$/mu);
  const sections = new Map();
  for (let index = 1; index < entries.length; index += 2)
    sections.set(entries[index], entries[index + 1]);
  const keys = [
    `pkg.rustc.target.${target}`,
    `pkg.cargo.target.${target}`,
    `pkg.rust-std.target.${target}`,
    'pkg.rust-src.target."*"',
  ];
  return keys.map((name) => {
    const section = sections.get(name) ?? "";
    const url = section.match(/^xz_url = "([^"]+)"/mu)?.[1];
    const hash = section.match(/^xz_hash = "([a-f0-9]{64})"/mu)?.[1];
    if (!url || !hash || !section.includes("available = true"))
      throw new Error(`Missing pinned Rust component ${name}`);
    return { component: name, url, sha256: hash };
  });
}
