import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PUBLIC_WINDOWS_RIPGREP_PINS as pins,
  assertSha256,
  sha256,
  stripPrivateCargoRegistry,
} from "./public-windows-ripgrep-plan.mjs";

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

export async function preparePublicRipgrepSources(workDir, artifactsDir) {
  await mkdir(workDir, { recursive: false });
  await mkdir(artifactsDir, { recursive: true });
  const sourceDir = join(workDir, "source");
  await mkdir(sourceDir);
  const [source, patch, manifest, patchLicense] = await Promise.all([
    fetchPinnedBytes(pins.sourceUrl, pins.sourceSha256, "ripgrep source"),
    fetchPinnedBytes(pins.patchUrl, pins.patchSha256, "Microsoft patch"),
    fetchPinnedBytes(pins.rustManifestUrl, pins.rustManifestSha256, "Rust manifest"),
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
  // source archive has no .git; stop git from attributing the enclosing verification branch to rg.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(sourceDir) };
  await execute("git", ["apply", "--check", patchPath], { cwd: sourceDir, env });
  await execute("git", ["apply", patchPath], { cwd: sourceDir, env });
  const configPath = join(sourceDir, ".cargo", "config.toml");
  await writeFile(configPath, stripPrivateCargoRegistry(await readFile(configPath, "utf8")));
  const lock = await readFile(join(sourceDir, "Cargo.lock"));
  await writeFile(join(artifactsDir, "Cargo.lock"), lock);
  await writeFile(join(artifactsDir, "patched-cargo-config.toml"), await readFile(configPath));
  return { sourceDir, manifest: manifest.toString("utf8"), cargoLockSha256: sha256(lock) };
}
