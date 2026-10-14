import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256 } from "./public-windows-ripgrep-plan.mjs";

async function locateNativeNotices(env, sdkOnly = false) {
  const roots = (
    sdkOnly
      ? [join(env.WindowsSdkDir ?? "", "Licenses")]
      : [
          join(env.VSINSTALLDIR ?? "", "Licenses"),
          join(env.VCINSTALLDIR ?? "", "Redist"),
          join(env.VSINSTALLDIR ?? "", "Common7", "IDE", "Licenses"),
        ]
  ).filter(
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
          source: sdkOnly
            ? `installed:Microsoft-Windows-SDK/${env.WindowsSDKVersion.replace(/[\\/]+$/u, "")}/${path.slice(env.WindowsSdkDir.length).replaceAll("\\", "/")}`
            : "installed Microsoft Visual Studio/MSVC redistribution material",
          sha256: sha256(await readFile(path)),
        });
    }
  }
  for (const root of roots) await visit(root, 4);
  return notices;
}

export async function collectNativeWindowsRuntimeEvidence(env, arch) {
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
  if (!env.WindowsSdkDir || !env.WindowsSDKVersion)
    throw new Error("Missing actual Windows SDK directory/version");
  const sdkVersion = env.WindowsSDKVersion.replace(/[\\/]+$/u, "");
  const sdkLibraries = [];
  for (const [folder, name, component] of [
    ["ucrt", "libucrt.lib", "windows-sdk-ucrt"],
    ["um", "ntdll.lib", "windows-sdk-import"],
  ]) {
    const path = join(env.WindowsSdkDir, "Lib", sdkVersion, folder, arch, name);
    sdkLibraries.push({ path, component, sha256: sha256(await readFile(path)) });
  }
  return {
    visualStudioVersion: env.UWORK_VS_INSTALLATION_VERSION,
    vcToolsVersion: env.VCToolsVersion,
    vcToolsInstallDir: env.VCToolsInstallDir,
    windowsSdkVersion: env.WindowsSDKVersion,
    windowsSdkRoot: env.WindowsSdkDir,
    sdkLibraries,
    sdkNotices: await locateNativeNotices(env, true),
    spectreDirectory: spectreDir,
    spectreComponentId: env.UWORK_SPECTRE_COMPONENT_ID,
    spectreInstallationRequested: env.UWORK_SPECTRE_INSTALLATION_REQUESTED,
    spectreLibraries,
    linkSearchOrder: (env.LIB ?? "").split(";"),
    notices: await locateNativeNotices(env),
  };
}
