import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
export const releaseTargets = ["mac-arm64", "mac-x64", "win-x64", "linux-x64", "linux-arm64"];
const formats = {
  mac: [".dmg", ".zip"],
  win: [".exe"],
  linux: [".AppImage", ".deb", ".rpm", ".pkg.tar.zst"],
};
function matchesTarget(name, platform, arch, version) {
  const architectures =
    platform === "linux"
      ? arch === "x64"
        ? ["x64", "x86_64", "amd64"]
        : ["arm64", "aarch64"]
      : [arch];
  return architectures.some((value) =>
    formats[platform].some((ext) => name === `UWork-${version}-${platform}-${value}${ext}`),
  );
}
export function validateDependencyAudit(audit) {
  const counts = audit?.metadata?.vulnerabilities;
  if (
    !counts ||
    !Number.isInteger(counts.high) ||
    !Number.isInteger(counts.critical) ||
    counts.high !== 0 ||
    counts.critical !== 0
  )
    throw new Error("Release dependency audit contains high/critical findings or is invalid");
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function identity(version, sha) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Invalid release version or commit");
}
export async function stageReleaseAssets({ source, destination, platform, arch, version, sha }) {
  identity(version, sha);
  const target = `${platform}-${arch}`;
  if (!releaseTargets.includes(target)) throw new Error("Unsupported release target");
  const names = (await readdir(source)).filter((name) =>
    matchesTarget(name, platform, arch, version),
  );
  for (const ext of formats[platform]) {
    if (names.filter((name) => name.endsWith(ext)).length !== 1)
      throw new Error(`Missing or duplicate ${target} ${ext} artifact`);
  }
  await mkdir(destination, { recursive: true });
  const files = [];
  for (const name of names.sort()) {
    const input = join(source, name);
    const info = await stat(input);
    if (!info.isFile() || info.size <= 0 || info.size > 500 * 1024 * 1024)
      throw new Error(`Invalid artifact size: ${name}`);
    await cp(input, join(destination, name));
    files.push({ name, size: info.size, sha256: await digest(join(destination, name)) });
  }
  await writeFile(
    join(destination, `uwork-${target}.json`),
    JSON.stringify({ version, sha, target, files }, null, 2) + "\n",
  );
}
export async function validateReleaseAssets({ directory, version, sha }) {
  identity(version, sha);
  const files = [];
  const unique = new Set();
  for (const target of releaseTargets) {
    const manifest = JSON.parse(await readFile(join(directory, `uwork-${target}.json`), "utf8"));
    if (
      manifest.version !== version ||
      manifest.sha !== sha ||
      manifest.target !== target ||
      !Array.isArray(manifest.files)
    )
      throw new Error(`Release identity mismatch: ${target}`);
    const platform = target.split("-")[0];
    const arch = target.split("-")[1];
    if (manifest.files.length !== formats[platform].length)
      throw new Error(`Release artifact count mismatch: ${target}`);
    for (const ext of formats[platform]) {
      if (manifest.files.filter((file) => file.name.endsWith(ext)).length !== 1)
        throw new Error(`Missing required artifact: ${target} ${ext}`);
    }
    for (const file of manifest.files) {
      if (
        basename(file.name) !== file.name ||
        !matchesTarget(file.name, platform, arch, version) ||
        unique.has(file.name)
      )
        throw new Error("Invalid or duplicate release asset name");
      unique.add(file.name);
      const info = await stat(join(directory, file.name));
      if (
        !info.isFile() ||
        info.size !== file.size ||
        info.size <= 0 ||
        (await digest(join(directory, file.name))) !== file.sha256
      )
        throw new Error(`Release checksum mismatch: ${file.name}`);
      files.push(file);
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
async function main() {
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const sha = process.env.GITHUB_SHA || process.env.RELEASE_SHA;
  const directory = resolve(process.env.RELEASE_ASSET_DIR || "release-assets");
  if (process.argv[2] === "stage") {
    await stageReleaseAssets({
      source: join(root, "packages/desktop/dist"),
      destination: directory,
      platform: process.argv[3],
      arch: process.argv[4],
      version,
      sha,
    });
  } else if (process.argv[2] === "assemble") {
    const files = await validateReleaseAssets({ directory, version, sha });
    await writeFile(
      join(directory, "SHA256SUMS"),
      files.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n",
    );
    const audit = JSON.parse(await readFile(join(directory, "dependency-audit.json"), "utf8"));
    validateDependencyAudit(audit);
    const notes = [
      `UWork ${version}`,
      "",
      `源码提交：${sha}`,
      "",
      "包含 macOS Apple Silicon / Intel、Windows x64、Linux x64 / ARM64 安装包。",
      "",
      "macOS 使用 ad-hoc 签名，未经过 Apple 公证；Windows 包未配置发布者证书。Linux AppImage 下载后需添加执行权限。",
      "",
      "依赖审计无 high/critical 报告；完整报告及 SHA256SUMS 随本次发布提供。",
      "",
      ...files.map((file) => `- ${file.name}`),
      "",
    ];
    await writeFile(join(directory, "release-notes.md"), notes.join("\n"));
    console.log(`Verified ${files.length} installers across ${releaseTargets.length} targets`);
  } else throw new Error("Use desktop-release.mjs stage <mac|win|linux> <arch>, or assemble");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
