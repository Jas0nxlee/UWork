import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wecomIdentityConfigSchema } from "../packages/shared/src/index.js";

const root = resolve(import.meta.dirname, "..");
const stagedFile = join(root, "packages/desktop/.release-config/enterprise-identity.json");
function parse(raw: unknown) {
  const parsed = wecomIdentityConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid bundled enterprise identity configuration");
  return parsed.data;
}
async function readConfig(file: string) {
  try {
    const raw = await readFile(file, "utf8");
    if (raw.length > 16384) throw new Error("oversized");
    return parse(JSON.parse(raw));
  } catch {
    throw new Error("Invalid or missing bundled enterprise identity configuration");
  }
}
export async function stageEnterpriseIdentityConfig(raw: unknown, destination: string) {
  const config = parse(raw);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(config, null, 2) + "\n", { mode: 0o644 });
  // Linux 安装文件由 root 拥有；公开参数必须可供普通桌面用户读取。
  await chmod(destination, 0o644);
  return { organizationCount: config.organizations.length };
}
export async function verifyPackagedEnterpriseIdentityConfig(resources: string, expected: string) {
  const packagedFile = join(resources, "config", "enterprise-identity.json");
  const [packaged, staged] = await Promise.all([readConfig(packagedFile), readConfig(expected)]);
  if (JSON.stringify(packaged) !== JSON.stringify(staged))
    throw new Error("Bundled enterprise identity configuration mismatch");
  if (((await stat(packagedFile)).mode & 0o444) !== 0o444)
    throw new Error("Bundled public enterprise identity configuration must be readable");
}
function resourcesPath(platform: string, arch: string) {
  const dist = join(root, "packages/desktop", process.env.ZCODE_DESKTOP_DIST_DIR || "dist");
  if (platform === "mac")
    return join(dist, arch === "arm64" ? "mac-arm64" : "mac", "UWork.app/Contents/Resources");
  if (platform === "win")
    return join(dist, arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked", "resources");
  if (platform === "linux")
    return join(dist, arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked", "resources");
  throw new Error("Invalid release platform");
}
async function main() {
  if (process.argv[2] === "stage") {
    let config: unknown;
    if (process.argv[3]) config = await readConfig(process.argv[3]);
    else {
      try {
        const raw = process.env.UWORK_ENTERPRISE_IDENTITY_CONFIG;
        if (!raw || raw.length > 16384) throw new Error("missing");
        config = JSON.parse(raw);
      } catch {
        throw new Error("Invalid or missing release enterprise identity configuration");
      }
    }
    const summary = await stageEnterpriseIdentityConfig(config, stagedFile);
    console.log(
      `Bundled enterprise identity configuration staged: ${summary.organizationCount} organization(s)`,
    );
  } else if (process.argv[2] === "verify") {
    await verifyPackagedEnterpriseIdentityConfig(
      resourcesPath(process.argv[3], process.argv[4]),
      stagedFile,
    );
    console.log("Packaged enterprise identity configuration verified");
  } else throw new Error("Use stage [source-file], or verify <mac|win|linux> <arch>");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Enterprise identity packaging failed");
    process.exitCode = 1;
  });
}
